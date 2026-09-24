import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError, toAppError } from '../../shared/errors'
import type { DownloadEvent, DownloadTarget } from '../../shared/events'
import { downloadKey } from '../../shared/events'
import { MODEL_IDS, type ModelFormat, type ModelId } from '../../shared/models'
import { pathExists } from '../fs-utils'
import { modelDir, type AppPaths } from '../paths'
import { ensureFreeSpace, type StatFs } from './disk'
import { downloadWithRetry, type FetchFn } from './http'
import { cudaSize, cudaTarget, modelFileUrl, modelSize, type Manifest } from './manifest'
import { extractNvidiaLibs } from './unzip'

export interface InstallerDeps {
  manifest: Manifest
  paths: AppPaths
  fetch: FetchFn
  emit: (event: DownloadEvent) => void
  platform: string
  arch: string
  statfs?: StatFs
  sleep?: (ms: number) => Promise<void>
}

interface PlannedFile {
  url: string
  dest: string
  size: number
  sha256: string
}

const MARKER = '.complete'
// Wheel compactado + bibliotecas extraídas convivem no disco durante a instalação.
const CUDA_SPACE_FACTOR = 3

export class Installer {
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly deps: InstallerDeps) {}

  isModelInstalled(id: ModelId, format: ModelFormat = 'ct2'): Promise<boolean> {
    return pathExists(join(modelDir(this.deps.paths, id, format), MARKER))
  }

  private manifestFor(id: ModelId, format: ModelFormat) {
    return format === 'ggml' ? this.deps.manifest.ggml[id] : this.deps.manifest.models[id]
  }

  /** Downloads começados e não concluídos: o onboarding volta a oferecer o mesmo modelo. */
  async partialModels(format: ModelFormat = 'ct2'): Promise<ModelId[]> {
    const partial: ModelId[] = []
    for (const id of MODEL_IDS) {
      const started = await pathExists(modelDir(this.deps.paths, id, format))
      if (started && !(await this.isModelInstalled(id, format))) partial.push(id)
    }
    return partial
  }

  async installedModels(format: ModelFormat = 'ct2'): Promise<ModelId[]> {
    const installed: ModelId[] = []
    for (const id of MODEL_IDS) if (await this.isModelInstalled(id, format)) installed.push(id)
    return installed
  }

  modelSizes(format: ModelFormat = 'ct2'): Record<ModelId, number> {
    const size = (id: ModelId): number => modelSize(this.manifestFor(id, format))
    return {
      small: size('small'),
      medium: size('medium'),
      'large-v3-turbo': size('large-v3-turbo'),
      'large-v3': size('large-v3')
    }
  }

  async installModel(id: ModelId, format: ModelFormat = 'ct2'): Promise<void> {
    const model = this.manifestFor(id, format)
    const dir = modelDir(this.deps.paths, id, format)
    const files = model.files.map((file) => ({
      url: modelFileUrl(model, file),
      dest: join(dir, file.path),
      size: file.size,
      sha256: file.sha256
    }))
    // O formato ct2 mantém o alvo antigo (sem "format"), que a interface já conhece.
    const target: DownloadTarget =
      format === 'ggml' ? { kind: 'model', id, format } : { kind: 'model', id }
    await this.run(target, files, dir, 1, async () => {
      await writeFile(join(dir, MARKER), '')
    })
  }

  async removeModel(id: ModelId, format: ModelFormat = 'ct2'): Promise<void> {
    await rm(modelDir(this.deps.paths, id, format), { recursive: true, force: true })
  }

  cudaSupported(): boolean {
    return cudaTarget(this.deps.platform, this.deps.arch) !== null
  }

  cudaSize(): number {
    const target = cudaTarget(this.deps.platform, this.deps.arch) ?? 'linux-x64'
    return cudaSize(this.deps.manifest.cuda[target])
  }

  isCudaInstalled(): Promise<boolean> {
    return pathExists(join(this.deps.paths.cuda, MARKER))
  }

  async installCuda(): Promise<void> {
    const target = cudaTarget(this.deps.platform, this.deps.arch)
    if (!target)
      throw new AppError(
        'CUDA_UNAVAILABLE',
        'Aceleração por GPU NVIDIA não é suportada neste sistema'
      )
    const { cuda } = this.deps.paths
    const staging = `${cuda}.download`
    const wheels = this.deps.manifest.cuda[target].map((wheel) => ({
      url: wheel.url,
      dest: join(staging, wheel.name),
      size: wheel.size,
      sha256: wheel.sha256
    }))
    await this.run({ kind: 'cuda' }, wheels, staging, CUDA_SPACE_FACTOR, async () => {
      await rm(cuda, { recursive: true, force: true })
      for (const wheel of wheels) await extractNvidiaLibs(wheel.dest, cuda)
      await writeFile(join(cuda, MARKER), '')
      await rm(staging, { recursive: true, force: true })
    })
  }

  async removeCuda(): Promise<void> {
    const { cuda } = this.deps.paths
    await Promise.all([
      rm(cuda, { recursive: true, force: true }),
      rm(`${cuda}.download`, { recursive: true, force: true })
    ])
  }

  cancel(target: DownloadTarget): void {
    this.active.get(downloadKey(target))?.abort()
  }

  private async run(
    target: DownloadTarget,
    files: PlannedFile[],
    dir: string,
    spaceFactor: number,
    finish: () => Promise<void>
  ): Promise<void> {
    const key = downloadKey(target)
    if (this.active.has(key))
      throw new AppError('INVALID_REQUEST', 'Este download já está em andamento')
    const controller = new AbortController()
    this.active.set(key, controller)
    try {
      await this.downloadAll(target, files, dir, spaceFactor, controller.signal)
      await finish()
      this.deps.emit({ type: 'done', target })
    } catch (error) {
      const failure = toAppError(error)
      this.deps.emit(
        failure.code === 'CANCELED'
          ? { type: 'canceled', target }
          : { type: 'failed', target, error: failure.toInfo() }
      )
      throw failure
    } finally {
      this.active.delete(key)
    }
  }

  private async downloadAll(
    target: DownloadTarget,
    files: PlannedFile[],
    dir: string,
    spaceFactor: number,
    signal: AbortSignal
  ): Promise<void> {
    await mkdir(dir, { recursive: true })
    const total = files.reduce((sum, file) => sum + file.size, 0)
    await ensureFreeSpace(dir, total * spaceFactor, this.deps.statfs)
    let done = 0
    for (const file of files) {
      if (!(await pathExists(file.dest))) {
        const base = done
        await downloadWithRetry(
          {
            ...file,
            fetch: this.deps.fetch,
            signal,
            onProgress: (received) => {
              this.deps.emit({ type: 'progress', target, received: base + received, total })
            }
          },
          { sleep: this.deps.sleep }
        )
      }
      done += file.size
    }
  }
}
