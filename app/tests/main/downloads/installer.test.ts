import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Installer, type InstallerDeps } from '../../../src/main/downloads/installer'
import type { Manifest } from '../../../src/main/downloads/manifest'
import { pathExists } from '../../../src/main/fs-utils'
import { appPaths } from '../../../src/main/paths'
import { AppError } from '../../../src/shared/errors'
import type { DownloadEvent } from '../../../src/shared/events'
import { makeTempDir } from '../../helpers/tmp'
import { makeWheel } from '../../helpers/zip'

const server = setupServer()
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const REV = 'a'.repeat(40)
const MODEL_BIN = Buffer.from('pesos '.repeat(200))
const CONFIG = Buffer.from('{"x":1}')
const GGML = Buffer.from('ggml '.repeat(300))

function ggmlEntry(id: string) {
  return {
    repo: 'ggerganov/whisper.cpp',
    revision: REV,
    files: [{ path: `ggml-${id}.bin`, size: GGML.length, sha256: sha(GGML) }]
  }
}

function modelEntry() {
  return {
    repo: 'Systran/faster-whisper-small',
    revision: REV,
    files: [
      { path: 'model.bin', size: MODEL_BIN.length, sha256: sha(MODEL_BIN) },
      { path: 'config.json', size: CONFIG.length, sha256: sha(CONFIG) }
    ]
  }
}

async function setup(overrides: Partial<InstallerDeps> = {}, wheelBytes?: Buffer) {
  const dir = await makeTempDir()
  const wheel = wheelBytes ?? Buffer.from('x')
  const wheelEntry = {
    name: 'nvidia_x.whl',
    url: 'https://files.pythonhosted.org/p/nvidia_x.whl',
    size: wheel.length,
    sha256: sha(wheel)
  }
  const manifest = {
    version: 1,
    models: {
      small: modelEntry(),
      medium: modelEntry(),
      'large-v3-turbo': modelEntry(),
      'large-v3': modelEntry()
    },
    ggml: {
      small: ggmlEntry('small'),
      medium: ggmlEntry('medium'),
      'large-v3-turbo': ggmlEntry('large-v3-turbo'),
      'large-v3': ggmlEntry('large-v3')
    },
    cuda: { 'win32-x64': [wheelEntry], 'linux-x64': [wheelEntry] }
  } as Manifest
  server.use(
    http.get(
      `https://huggingface.co/Systran/faster-whisper-small/resolve/${REV}/model.bin`,
      () => new HttpResponse(MODEL_BIN)
    ),
    http.get(
      `https://huggingface.co/Systran/faster-whisper-small/resolve/${REV}/config.json`,
      () => new HttpResponse(CONFIG)
    ),
    http.get(wheelEntry.url, () => new HttpResponse(wheel)),
    http.get(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${REV}/ggml-small.bin`,
      () => new HttpResponse(GGML)
    )
  )
  const events: DownloadEvent[] = []
  const paths = appPaths(dir)
  const installer = new Installer({
    manifest,
    paths,
    fetch: (url, init) => fetch(url, init),
    emit: (e) => events.push(e),
    platform: 'linux',
    arch: 'x64',
    statfs: () => Promise.resolve({ bavail: 1e12, bsize: 1 }),
    sleep: () => Promise.resolve(),
    ...overrides
  })
  return { installer, events, paths, manifest }
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('Installer — modelos GGML (whisper.cpp)', () => {
  it('instala em models-ggml, separado do formato do faster-whisper, com evento marcado', async () => {
    const { installer, events, paths } = await setup()
    await installer.installModel('small', 'ggml')
    expect(await readFile(join(paths.modelsGgml, 'small', 'ggml-small.bin'))).toEqual(GGML)
    expect(await installer.installedModels('ggml')).toEqual(['small'])
    expect(await installer.installedModels()).toEqual([])
    expect(installer.modelSizes('ggml').small).toBe(GGML.length)
    expect(events.at(-1)).toEqual({
      type: 'done',
      target: { kind: 'model', id: 'small', format: 'ggml' }
    })
    await installer.removeModel('small', 'ggml')
    expect(await installer.installedModels('ggml')).toEqual([])
  })

  it('parciais e cancelamento por formato', async () => {
    const { installer, paths } = await setup()
    await mkdir(join(paths.modelsGgml, 'medium'), { recursive: true })
    expect(await installer.partialModels('ggml')).toEqual(['medium'])
    expect(await installer.partialModels()).toEqual([])
    installer.cancel({ kind: 'model', id: 'medium', format: 'ggml' }) // nada em andamento: sem erro
  })
})

describe('Installer — modelos', () => {
  it('partialModels: pasta começada e sem marca de concluído (download interrompido)', async () => {
    const { installer, paths } = await setup()
    await mkdir(join(paths.models, 'large-v3'), { recursive: true })
    await writeFile(join(paths.models, 'large-v3', 'model.bin.part'), 'x')
    await installer.installModel('small')
    expect(await installer.partialModels()).toEqual(['large-v3'])
  })

  it('baixa todos os arquivos, marca como instalado e emite progresso agregado', async () => {
    const { installer, events, paths } = await setup()
    expect(await installer.isModelInstalled('small')).toBe(false)
    await installer.installModel('small')
    expect(await installer.isModelInstalled('small')).toBe(true)
    expect(await installer.installedModels()).toEqual(['small'])
    expect(await readFile(join(paths.models, 'small', 'model.bin'))).toEqual(MODEL_BIN)
    const total = MODEL_BIN.length + CONFIG.length
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e] : []))
    expect(progress.every((e) => e.total === total)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ received: total })
    expect(events.at(-1)).toEqual({ type: 'done', target: { kind: 'model', id: 'small' } })
    await installer.removeModel('small')
    expect(await installer.isModelInstalled('small')).toBe(false)
  })

  it('pula arquivos já verificados de uma tentativa anterior', async () => {
    const { installer, paths } = await setup()
    await installer.installModel('small')
    await rm(join(paths.models, 'small', '.complete')) // simula instalação interrompida no fim
    const handler = vi.fn(() => new HttpResponse(MODEL_BIN))
    server.use(http.get(/model\.bin$/, handler))
    await installer.installModel('small')
    expect(handler).not.toHaveBeenCalled()
    expect(await installer.isModelInstalled('small')).toBe(true)
  })

  it('sem espaço → INSUFFICIENT_SPACE e evento failed', async () => {
    const { installer, events } = await setup({
      statfs: () => Promise.resolve({ bavail: 1, bsize: 1 })
    })
    await expect(installer.installModel('small')).rejects.toSatisfy(isCode('INSUFFICIENT_SPACE'))
    expect(events.at(-1)).toMatchObject({ type: 'failed', error: { code: 'INSUFFICIENT_SPACE' } })
  })

  it('download duplicado do mesmo alvo → INVALID_REQUEST', async () => {
    const { installer } = await setup()
    const first = installer.installModel('small')
    await expect(installer.installModel('small')).rejects.toSatisfy(isCode('INVALID_REQUEST'))
    await first
  })

  it('cancel() interrompe e emite canceled', async () => {
    const { installer, events } = await setup()
    server.use(
      http.get(/model\.bin$/, async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return new HttpResponse(MODEL_BIN)
      })
    )
    const pending = installer.installModel('small')
    installer.cancel({ kind: 'model', id: 'small' })
    await expect(pending).rejects.toSatisfy(isCode('CANCELED'))
    expect(events.at(-1)).toEqual({ type: 'canceled', target: { kind: 'model', id: 'small' } })
    installer.cancel({ kind: 'cuda' }) // nada em andamento: não faz nada
  })

  it('tamanhos vêm do manifesto', async () => {
    const { installer } = await setup()
    expect(installer.modelSizes().small).toBe(MODEL_BIN.length + CONFIG.length)
    expect(installer.cudaSize()).toBe(1)
  })
})

describe('Installer — CUDA', () => {
  it('baixa os wheels, extrai só nvidia/ e marca como instalado', async () => {
    const dir = await makeTempDir()
    const wheelPath = join(dir, 'w.whl')
    await makeWheel(wheelPath, {
      'nvidia/cublas/lib/libcublas.so.12': 'bin',
      'x.dist-info/RECORD': 'r'
    })
    const { installer, paths, events } = await setup({}, await readFile(wheelPath))
    expect(installer.cudaSupported()).toBe(true)
    await installer.installCuda()
    expect(await installer.isCudaInstalled()).toBe(true)
    expect(
      await readFile(join(paths.cuda, 'nvidia', 'cublas', 'lib', 'libcublas.so.12'), 'utf8')
    ).toBe('bin')
    expect(await pathExists(`${paths.cuda}.download`)).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'done', target: { kind: 'cuda' } })
    await installer.removeCuda()
    expect(await installer.isCudaInstalled()).toBe(false)
  })

  it('macOS não suporta CUDA', async () => {
    const { installer } = await setup({ platform: 'darwin', arch: 'arm64' })
    expect(installer.cudaSupported()).toBe(false)
    expect(installer.cudaSize()).toBe(1) // tamanho de referência mesmo sem suporte
    await expect(installer.installCuda()).rejects.toSatisfy(isCode('CUDA_UNAVAILABLE'))
  })
})
