import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { AppError, toAppError } from '../../shared/errors'
import type { EnqueueResult, QueueEvent, QueueState } from '../../shared/events'
import type { HistoryMeta } from '../../shared/history'
import { fileNameOf, mediaKindOf } from '../../shared/media'
import { formatForDevice, type ModelFormat, type ModelId } from '../../shared/models'
import type { Device, Settings, Track } from '../../shared/settings'
import type { HistoryStore } from '../history/store'
import type { JobEvent } from '../worker/protocol'
import type { Logger, WorkerPort } from '../worker/supervisor'

export interface QueueDeps {
  history: HistoryStore
  settings: { get(): Settings }
  worker: WorkerPort
  modelDir: (id: ModelId, format: ModelFormat) => string
  cudaLibDir: string
  emit: (event: QueueEvent) => void
  logger: Logger
  isFile?: (path: string) => Promise<boolean>
  /** Modelo já baixado naquele formato (sem ele, a queda da GPU fica no whisper.cpp). */
  hasModel?: (id: ModelId, format: ModelFormat) => Promise<boolean>
}

/** Onde o job roda agora e qual configuração escolhe a engine/formato do modelo. */
interface Target {
  device: Device
  configured: Device
}

interface JobResult {
  duration: number | null
  languageDetected: string | null
}

/** Uma das faixas do refazer do ao vivo: o falante e a fatia do progresso total. */
interface TrackPass {
  track: Track
  index: number
  count: number
}

// Um abort nativo do driver/cuDNN derruba o processo: o supervisor vê WORKER_CRASHED.
const GPU_FAILURES = new Set(['CUDA_FAILED', 'CUDA_UNAVAILABLE', 'GPU_FAILED', 'WORKER_CRASHED'])

// Concluído também: "nenhuma fala reconhecida" pede uma nova tentativa (outro modelo/idioma).
const RETRYABLE: ReadonlySet<string> = new Set(['interrupted', 'failed', 'canceled', 'done'])

async function isFileOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const canceledError = () => new AppError('CANCELED', 'Transcrição cancelada')

export class TranscriptionQueue {
  private readonly pending: string[] = []
  private readonly retrying = new Set<string>()
  private current: string | null = null
  private canceledId: string | null = null
  private stopping = false
  private testing = false
  private live = false // sessão ao vivo: o worker é dela, a fila espera
  // Configurações em que a GPU já falhou nesta sessão: até mudarem, os jobs vão direto para a CPU.
  private gpuFailedFor: Settings | null = null
  private fallback: Target = { device: 'cpu', configured: 'cpu' }
  private loop: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()

  private readonly isFile: (path: string) => Promise<boolean>
  private readonly hasModel: (id: ModelId, format: ModelFormat) => Promise<boolean>

  constructor(private readonly deps: QueueDeps) {
    this.isFile = deps.isFile ?? isFileOnDisk
    this.hasModel = deps.hasModel ?? (() => Promise.resolve(false))
  }

  async restore(): Promise<void> {
    const { entries } = await this.deps.history.list()
    for (const meta of entries.filter((e) => e.status === 'processing')) {
      await this.deps.history.update(meta.id, { status: 'interrupted' })
    }
    const queued = entries.filter((e) => e.status === 'queued').reverse() // list() vem do mais novo
    this.pending.push(...queued.map((e) => e.id))
    this.pump()
  }

  async enqueue(paths: string[]): Promise<EnqueueResult> {
    const settings = this.deps.settings.get()
    const model = requireModel(settings)
    const accepted: HistoryMeta[] = []
    const rejected: string[] = []
    for (const sourcePath of paths) {
      const mediaKind = mediaKindOf(sourcePath)
      if (!mediaKind || !(await this.isReadableFile(sourcePath))) {
        rejected.push(sourcePath)
        continue
      }
      const meta = await this.deps.history.create({
        sourcePath,
        mediaKind,
        model,
        language: languageOf(settings)
      })
      accepted.push(meta)
      this.pending.push(meta.id)
      this.deps.emit({ type: 'job', meta })
    }
    this.pump()
    return { accepted, rejected }
  }

  async remove(id: string): Promise<void> {
    const index = this.pending.indexOf(id)
    if (index < 0)
      throw new AppError('INVALID_REQUEST', 'Só itens aguardando na fila podem ser removidos')
    this.pending.splice(index, 1)
    await this.deps.history.remove(id)
    this.deps.emit({ type: 'removed', jobId: id })
  }

  /** Refaz um job parado (inclusive concluído); `sourcePath` troca o arquivo (original movido). */
  async retry(id: string, sourcePath?: string): Promise<HistoryMeta> {
    // Clique duplo: a segunda chamada chega antes de a primeira gravar "queued".
    if (this.retrying.has(id))
      throw new AppError('INVALID_REQUEST', 'Este item já está sendo refeito')
    this.retrying.add(id)
    try {
      return await this.requeue(id, sourcePath)
    } finally {
      this.retrying.delete(id)
    }
  }

  private async requeue(id: string, sourcePath: string | undefined): Promise<HistoryMeta> {
    const meta = await this.deps.history.get(id)
    if (!RETRYABLE.has(meta.status)) {
      throw new AppError('INVALID_REQUEST', 'Este item ainda está na fila')
    }
    if (meta.kind === 'live') await this.deps.history.prepareRedo(meta)
    const source = sourcePath === undefined ? {} : await this.sourceFields(sourcePath)
    // Outro arquivo: o áudio extraído do antigo não serve. Mesmo arquivo: o worker reaproveita.
    if (sourcePath === undefined) await this.deps.history.discardPartial(id)
    else await this.deps.history.discardOutputs(id)
    const updated = await this.setStatus(id, { ...source, status: 'queued', error: null })
    this.pending.push(id)
    this.pump()
    return updated
  }

  /** Exclui do histórico um item parado (inclusive corrompido). */
  async removeEntry(id: string): Promise<void> {
    if (id === this.current || this.pending.includes(id)) {
      throw new AppError('INVALID_REQUEST', 'Este item ainda está na fila')
    }
    await this.deps.history.remove(id)
    this.deps.emit({ type: 'removed', jobId: id })
  }

  /** Item ao vivo: mostra a versão refeita ou a ao vivo. */
  async setVersion(id: string, version: 'live' | 'redo'): Promise<HistoryMeta> {
    const meta = await this.deps.history.get(id)
    if (meta.kind !== 'live') throw new AppError('INVALID_REQUEST', 'Item sem versões')
    if (version === 'redo' && !(await this.deps.history.hasRedo(meta))) {
      throw new AppError('INVALID_REQUEST', 'Este item ainda não foi refeito')
    }
    return this.setStatus(id, { activeVersion: version })
  }

  /** Marca o job atual; ele termina no próximo ponto de verificação, mesmo sem requisição pendente. */
  cancel(): void {
    if (this.current === null) return
    this.canceledId = this.current
    this.deps.worker.kill()
  }

  /**
   * App fechando: nenhum job novo começa e o atual não grava status — continua
   * "processing" no disco e o restore() o marca como interrompido na próxima abertura.
   */
  shutdown(): void {
    this.stopping = true
  }

  state(): QueueState {
    return { current: this.current, pending: [...this.pending] }
  }

  isIdle(): boolean {
    return this.current === null && this.pending.length === 0 && !this.testing && !this.live
  }

  /** Ao vivo: segura a fila (arquivos novos esperam) e carrega o modelo das configurações. */
  async holdForLive(): Promise<void> {
    if (!this.isIdle()) {
      throw new AppError('QUEUE_BUSY', 'Espere a fila terminar para começar o ao vivo')
    }
    this.live = true
    try {
      const settings = this.deps.settings.get()
      const target = this.targetFor(settings)
      await this.loadModel(requireModel(settings), target.device, target.configured)
    } catch (error) {
      this.releaseLive()
      throw error
    }
  }

  /** A GPU falhou no ao vivo: mesma regra da fila (resto da sessão na CPU). */
  async reloadLiveOnCpu(): Promise<void> {
    const settings = this.deps.settings.get()
    const model = requireModel(settings)
    this.gpuFailedFor = settings
    this.fallback = await this.cpuTarget(model, settings)
    // No mesmo processo: trocar de processo mataria a sessão ao vivo do worker (e os trechos na
    // fila dele). O ambiente do processo da GPU também roda a CPU.
    await this.loadModel(model, this.fallback.device, this.fallback.configured, settings.device)
  }

  releaseLive(): void {
    this.live = false
    this.pump()
  }

  whenIdle(): Promise<void> {
    return this.loop
  }

  /** O autoteste usa o mesmo motor da fila: só roda com ela parada, e ela espera ele acabar. */
  async selfTest(): Promise<void> {
    if (!this.isIdle()) {
      throw new AppError('INVALID_REQUEST', 'Aguarde a fila terminar para testar o motor')
    }
    this.testing = true
    try {
      const settings = this.deps.settings.get()
      await this.loadModel(requireModel(settings), settings.device, settings.device)
      await this.deps.worker.request({ cmd: 'self_test' }, { device: settings.device })
    } finally {
      this.testing = false
      this.pump()
    }
  }

  private async isReadableFile(path: string): Promise<boolean> {
    return isAbsolute(path) && (await this.isFile(path))
  }

  private async sourceFields(
    path: string
  ): Promise<Pick<HistoryMeta, 'sourcePath' | 'fileName' | 'mediaKind'>> {
    const mediaKind = mediaKindOf(path)
    if (!mediaKind) throw new AppError('UNSUPPORTED_FILE', 'Formato de arquivo não suportado')
    if (!(await this.isReadableFile(path))) {
      throw new AppError('FILE_NOT_FOUND', 'Arquivo não encontrado')
    }
    return { sourcePath: path, fileName: fileNameOf(path), mediaKind }
  }

  private pump(): void {
    if (this.current !== null || this.testing || this.live || this.stopping) return
    if (this.pending.length === 0) return
    this.loop = this.drain()
  }

  private async drain(): Promise<void> {
    for (let id = this.next(); id !== undefined; id = this.next()) {
      this.current = id
      this.writes = Promise.resolve()
      await this.runJob(id)
      this.current = null
      this.canceledId = null
    }
  }

  private next(): string | undefined {
    return this.stopping ? undefined : this.pending.shift()
  }

  /** Nunca rejeita: um erro aqui travaria a fila com `current` preso para sempre. */
  private async runJob(id: string): Promise<void> {
    const settings = this.deps.settings.get()
    let meta: HistoryMeta | null = null
    try {
      meta = await this.setStatus(id, {
        status: 'processing',
        error: null,
        model: requireModel(settings)
      })
      const result = await this.executeWithFallback(meta, settings)
      await this.writes
      await this.deps.history.finalize(id)
      this.checkCanceled(id)
      const redone = meta.kind === 'live' ? { activeVersion: 'redo' as const } : {}
      await this.setStatus(id, { status: 'done', ...result, ...redone })
    } catch (error) {
      await this.fail(id, error).catch((failure: unknown) => {
        this.reportLostFailure(meta, error, failure)
      })
    }
  }

  private checkCanceled(id: string): void {
    if (this.canceledId === id) throw canceledError()
  }

  private targetFor(settings: Settings): Target {
    if (this.gpuFailedFor === settings) return this.fallback
    return { device: settings.device, configured: settings.device }
  }

  /**
   * Na CPU o faster-whisper é mais rápido e não depende do binário da GPU; o whisper.cpp na CPU
   * (mesmo modelo GGML) só fica quando o modelo da CPU não foi baixado.
   */
  private async cpuTarget(model: ModelId, settings: Settings): Promise<Target> {
    const keepGgml = settings.device === 'gpu' && !(await this.hasModel(model, 'ct2'))
    return { device: 'cpu', configured: keepGgml ? 'gpu' : 'cpu' }
  }

  private async executeWithFallback(meta: HistoryMeta, settings: Settings): Promise<JobResult> {
    const target = this.targetFor(settings)
    try {
      return await this.execute(meta, settings, target)
    } catch (error) {
      const code = toAppError(error).code
      if (target.device === 'cpu' || this.canceledId === meta.id || !GPU_FAILURES.has(code))
        throw error
      this.deps.logger.warn(`[fila] GPU falhou (${code}); refazendo na CPU`)
      this.gpuFailedFor = settings
      this.fallback = await this.cpuTarget(meta.model, settings)
      this.deps.emit({ type: 'notice', jobId: meta.id, code: 'CUDA_FALLBACK' })
      await this.deps.history.discardPartial(meta.id)
      return this.execute(meta, settings, this.fallback)
    }
  }

  private async execute(meta: HistoryMeta, settings: Settings, target: Target): Promise<JobResult> {
    const { device } = target
    this.checkCanceled(meta.id)
    await this.loadModel(meta.model, device, target.configured)
    this.checkCanceled(meta.id)
    const result: JobResult = { duration: null, languageDetected: null }
    if (meta.kind === 'live') {
      await this.executeTracks(meta, settings, device, result)
      return result
    }
    await this.transcribe(meta, settings, device, result, {
      input: meta.sourcePath,
      audioOut: this.deps.history.paths(meta.id).audio,
      pass: null
    })
    return result
  }

  /** Refazer do ao vivo: cada faixa gravada inteira (já é m4a: o worker não extrai de novo). */
  private async executeTracks(
    meta: HistoryMeta,
    settings: Settings,
    device: Device,
    result: JobResult
  ): Promise<void> {
    const tracks = meta.tracks ?? []
    const dir = this.deps.history.paths(meta.id).dir
    for (const [index, track] of tracks.entries()) {
      this.checkCanceled(meta.id)
      const file = join(dir, `${track}.m4a`)
      const pass = { track, index, count: tracks.length }
      await this.transcribe(meta, settings, device, result, { input: file, audioOut: file, pass })
    }
  }

  private async transcribe(
    meta: HistoryMeta,
    settings: Settings,
    device: Device,
    result: JobResult,
    source: { input: string; audioOut: string; pass: TrackPass | null }
  ): Promise<void> {
    await this.deps.worker.request(
      {
        cmd: 'transcribe',
        params: {
          job_id: meta.id,
          input_path: source.input,
          language: languageOf(settings),
          audio_out_path: source.audioOut
        }
      },
      {
        device,
        onEvent: (event) => {
          this.onJobEvent(meta.id, event, result, source.pass)
        }
      }
    )
  }

  /** `configured` escolhe a engine (gpu → whisper.cpp com modelo GGML); `device` é onde roda. */
  private async loadModel(
    model: ModelId,
    device: Device,
    configured: Device,
    processDevice: Device = device
  ): Promise<void> {
    const format = formatForDevice(configured)
    const model_dir = this.deps.modelDir(model, format)
    const cuda = device === 'cuda'
    const params =
      format === 'ggml'
        ? { model_dir, device, engine: 'whisper-cpp' as const }
        : {
            model_dir,
            device,
            engine: 'faster-whisper' as const,
            compute_type: cuda ? ('float16' as const) : ('int8' as const),
            ...(cuda ? { cuda_lib_dir: this.deps.cudaLibDir } : {})
          }
    await this.deps.worker.request({ cmd: 'load_model', params }, { device: processDevice })
  }

  private onJobEvent(
    jobId: string,
    event: JobEvent,
    result: JobResult,
    pass: TrackPass | null
  ): void {
    switch (event.type) {
      case 'phase':
        this.deps.emit({ type: 'phase', jobId, phase: event.phase })
        return
      case 'progress':
        this.deps.emit({
          type: 'progress',
          jobId,
          pct: pass ? (pass.index * 100 + event.pct) / pass.count : event.pct,
          processedS: event.processed_s,
          totalS: event.total_s,
          speed: event.speed
        })
        return
      case 'segment': {
        const segment = {
          start: event.start,
          end: event.end,
          text: event.text,
          ...(pass ? { speaker: pass.track } : {})
        }
        this.writes = this.writes.then(() => this.deps.history.appendSegment(jobId, segment))
        this.deps.emit({ type: 'segment', jobId, segment })
        return
      }
      case 'done':
        // Várias faixas: a sessão dura o que dura a mais longa.
        result.duration = Math.max(result.duration ?? 0, event.duration)
        result.languageDetected ??= event.language_detected
    }
  }

  private async fail(id: string, error: unknown): Promise<void> {
    await this.writes.catch(() => undefined)
    if (this.stopping) {
      this.deps.logger.info(`[fila] job ${id} interrompido pelo fechamento do app`)
      return
    }
    const canceled = this.canceledId === id
    await this.deps.history.discardPartial(id) // o áudio extraído fica para refazer sem extrair
    const info = toAppError(error).toInfo()
    this.deps.logger.warn(`[fila] job ${id} terminou com ${canceled ? 'CANCELED' : info.code}`)
    await this.setStatus(id, canceled ? { status: 'canceled' } : { status: 'failed', error: info })
  }

  /** Nem o status de falha pôde ser gravado: avisa a interface mesmo assim e registra. */
  private reportLostFailure(meta: HistoryMeta | null, error: unknown, failure: unknown): void {
    const info = toAppError(error).toInfo()
    this.deps.logger.error(
      `[fila] não foi possível gravar a falha (${info.code}): ${toAppError(failure).message}`
    )
    if (meta) this.deps.emit({ type: 'job', meta: { ...meta, status: 'failed', error: info } })
  }

  private async setStatus(
    id: string,
    patch: Partial<Omit<HistoryMeta, 'id'>>
  ): Promise<HistoryMeta> {
    const meta = await this.deps.history.update(id, patch)
    this.deps.emit({ type: 'job', meta })
    return meta
  }
}

function requireModel(settings: Settings): ModelId {
  if (settings.model === null) {
    throw new AppError('MODEL_NOT_LOADED', 'Escolha um modelo antes de transcrever')
  }
  return settings.model
}

function languageOf(settings: Settings): string | null {
  return settings.audioLanguage === 'auto' ? null : settings.audioLanguage
}
