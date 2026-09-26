import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError, isErrorCode, toAppError } from '../../shared/errors'
import type { LiveEvent, LiveState } from '../../shared/events'
import type { HistoryMeta } from '../../shared/history'
import type { Settings, Track } from '../../shared/settings'
import type { HistoryStore } from '../history/store'
import type { LiveWorkerEvent, WorkerCommand } from '../worker/protocol'
import type { Logger } from '../worker/supervisor'
import { Downsampler } from './resample'
import { WavWriter } from './wav'

const BLOCK_48K = 4800 // 100 ms a 48 kHz: o tamanho dos blocos que a tela envia
const RELOADABLE: ReadonlySet<string> = new Set(['GPU_FAILED', 'CUDA_FAILED', 'CUDA_UNAVAILABLE'])

export interface LivePort {
  request(command: WorkerCommand): Promise<Record<string, unknown>>
  notify(command: WorkerCommand): boolean
}

export interface LiveQueue {
  holdForLive(): Promise<void>
  releaseLive(): void
  reloadLiveOnCpu(): Promise<void>
}

export interface TrackWriter {
  samples: number
  append(pcm: Int16Array): Promise<void>
  close(): Promise<void>
}

export interface LiveDeps {
  worker: LivePort
  queue: LiveQueue
  history: HistoryStore
  settings: { get(): Settings }
  emit: (event: LiveEvent) => void
  /** Item do histórico criado ou atualizado (a barra lateral mostra a sessão). */
  onItem: (meta: HistoryMeta) => void
  logger: Logger
  openWav?: (path: string) => Promise<TrackWriter>
}

export interface LiveStartOptions {
  tracks: Track[]
  test: boolean
  title: string
}

interface TrackState {
  down: Downsampler
  wav: TrackWriter | null
  lastSeq: number | null // último bloco recebido da tela (null = acabou de começar ou retomar)
  sent: number // próximo seq para o worker (o tempo pausado não conta)
}

interface Session {
  id: string
  itemId: string | null
  test: boolean
  tracks: Map<Track, TrackState>
  writes: Promise<unknown>
}

/**
 * Sessão ao vivo no main: grava cada faixa em WAV (48 kHz), reduz para 16 kHz e repassa ao worker;
 * recebe os trechos e, ao encerrar, finaliza a gravação e o item do histórico.
 */
export class LiveService {
  state: LiveState = 'idle'
  private session: Session | null = null
  private stopPromise: Promise<HistoryMeta | null> | null = null
  private readonly openWav: (path: string) => Promise<TrackWriter>

  constructor(private readonly deps: LiveDeps) {
    this.openWav = deps.openWav ?? ((path) => WavWriter.open(path))
  }

  async start(options: LiveStartOptions): Promise<{ sessionId: string; itemId: string | null }> {
    if (this.state !== 'idle') throw new AppError('LIVE_ACTIVE', 'Já há uma sessão ao vivo')
    this.setState('starting', options.test, null)
    try {
      await this.deps.queue.holdForLive()
    } catch (error) {
      this.setState('idle', options.test, null)
      throw error
    }
    try {
      return await this.open(options)
    } catch (error) {
      this.deps.queue.releaseLive()
      this.session = null
      this.setState('idle', options.test, null)
      throw error
    }
  }

  private async open(
    options: LiveStartOptions
  ): Promise<{ sessionId: string; itemId: string | null }> {
    const settings = this.deps.settings.get()
    const language = settings.audioLanguage === 'auto' ? null : settings.audioLanguage
    const meta = options.test ? null : await this.createItem(options, settings, language)
    const session: Session = {
      id: randomUUID(),
      itemId: meta?.id ?? null,
      test: options.test,
      tracks: new Map(),
      writes: Promise.resolve()
    }
    try {
      await this.connect(session, options, settings, language)
    } catch (error) {
      for (const state of session.tracks.values()) await state.wav?.close()
      if (meta) this.deps.onItem(await this.fail(meta.id, error))
      throw error
    }
    this.setState('recording', options.test, session.itemId)
    return { sessionId: session.id, itemId: session.itemId }
  }

  private async connect(
    session: Session,
    options: LiveStartOptions,
    settings: Settings,
    language: string | null
  ): Promise<void> {
    for (const track of options.tracks) {
      const wav = session.itemId
        ? await this.openWav(join(this.deps.history.paths(session.itemId).dir, `live-${track}.wav`))
        : null
      session.tracks.set(track, { down: new Downsampler(), wav, lastSeq: null, sent: 0 })
    }
    this.session = session
    await this.deps.worker.request({
      cmd: 'live_start',
      params: {
        session_id: session.id,
        tracks: options.tracks,
        language,
        pause_s: settings.live.pauseS,
        test: options.test
      }
    })
  }

  private fail(itemId: string, error: unknown): Promise<HistoryMeta> {
    return this.deps.history.update(itemId, { status: 'failed', error: toAppError(error).toInfo() })
  }

  private async createItem(
    options: LiveStartOptions,
    settings: Settings,
    language: string | null
  ): Promise<HistoryMeta> {
    if (settings.model === null) throw new AppError('MODEL_NOT_LOADED', 'Nenhum modelo escolhido')
    const meta = await this.deps.history.createLive({
      title: options.title,
      tracks: options.tracks,
      model: settings.model,
      language
    })
    this.deps.onItem(meta)
    return meta
  }

  audio(track: Track, seq: number, pcm: Int16Array): void {
    const session = this.session
    const state = session?.tracks.get(track)
    if (this.state !== 'recording' || !session || !state) return
    const missing = state.lastSeq === null ? 0 : seq - state.lastSeq - 1
    if (missing < 0) return // repetido ou fora de ordem
    state.lastSeq = seq
    state.sent += missing // o worker preenche o buraco com silêncio
    if (state.wav) this.record(session, state.wav, missing, pcm)
    const down = state.down.push(pcm)
    const sent = this.deps.worker.notify({
      cmd: 'live_audio',
      params: {
        session_id: session.id,
        track,
        seq: state.sent,
        pcm16_b64: Buffer.from(down.buffer, down.byteOffset, down.byteLength).toString('base64')
      }
    })
    state.sent += 1
    if (!sent) this.onWorkerLost()
  }

  /** O worker caiu no meio da sessão: avisa e encerra salvando o que foi gravado. */
  private onWorkerLost(): void {
    // Só chamado de audio(), que exige "gravando": o stop() leva a "encerrando" e não repete.
    this.deps.logger.error('[ao vivo] o motor parou no meio da sessão; encerrando')
    this.deps.emit({ type: 'error', code: 'WORKER_CRASHED' })
    void this.stop()
  }

  private record(session: Session, wav: TrackWriter, missing: number, pcm: Int16Array): void {
    const gap = missing > 0 ? wav.append(new Int16Array(missing * BLOCK_48K)) : Promise.resolve()
    const write = Promise.all([gap, wav.append(pcm)]).catch((error: unknown) => {
      this.onRecordError(error)
    })
    session.writes = session.writes.then(() => write)
  }

  private onRecordError(error: unknown): void {
    const code = (error as { code?: string }).code === 'ENOSPC' ? 'DISK_FULL' : 'INTERNAL'
    this.deps.logger.error(`[ao vivo] gravação falhou: ${String(error)}`)
    this.deps.emit({ type: 'error', code })
    void this.stop() // o stop ignora se a sessão já está encerrando
  }

  pause(): void {
    const session = this.session
    if (this.state !== 'recording' || !session) return
    this.setState('paused', session.test, session.itemId)
    // O worker fecha e transcreve a frase em andamento (a linha do tempo não muda).
    this.deps.worker
      .request({ cmd: 'live_pause', params: { session_id: session.id } })
      .catch((error: unknown) => {
        this.deps.logger.warn(`[ao vivo] pausa no worker falhou: ${toAppError(error).code}`)
      })
  }

  resume(): void {
    const session = this.session
    if (this.state !== 'paused' || !session) return
    for (const state of session.tracks.values()) state.lastSeq = null // recomeça a contar sem buraco
    this.setState('recording', session.test, session.itemId)
  }

  stop(): Promise<HistoryMeta | null> {
    const session = this.session
    if (!session || this.state === 'idle') return Promise.resolve(null)
    // Quem chega durante o encerramento espera a mesma finalização (ex.: "Parar" e depois "Sair").
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = this.runStop(session).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async runStop(session: Session): Promise<HistoryMeta | null> {
    this.setState('stopping', session.test, session.itemId)
    try {
      // Cada etapa falha sozinha: o que foi gravado sempre é fechado e finalizado.
      await this.attempt('live_stop', () =>
        this.deps.worker.request({ cmd: 'live_stop', params: { session_id: session.id } })
      )
      await this.attempt('trechos', () => session.writes)
      for (const state of session.tracks.values()) {
        if (state.wav) await this.attempt('fechar a gravação', () => state.wav?.close())
      }
      return session.itemId ? await this.finish(session.itemId, [...session.tracks.keys()]) : null
    } finally {
      this.session = null
      this.deps.queue.releaseLive()
      this.setState('idle', session.test, null)
    }
  }

  private async attempt(step: string, action: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.deps.logger.error(`[ao vivo] ${step} falhou: ${String(error)}`)
    }
  }

  private async finish(itemId: string, tracks: Track[]): Promise<HistoryMeta> {
    const { history } = this.deps
    try {
      const duration = await this.finalizeFiles(itemId, tracks)
      await history.finalizeLive(itemId)
      const meta = await history.update(itemId, { status: 'done', duration })
      this.deps.onItem(meta)
      return meta
    } catch (error) {
      const meta = await history.update(itemId, {
        status: 'failed',
        error: toAppError(error).toInfo()
      })
      this.deps.onItem(meta)
      return meta
    }
  }

  private async finalizeFiles(itemId: string, tracks: Track[]): Promise<number> {
    const dir = this.deps.history.paths(itemId).dir
    const result = await this.deps.worker.request({ cmd: 'live_finalize', params: { dir, tracks } })
    const durations = Object.values((result.durations ?? {}) as Record<string, number>)
    return durations.length ? Math.max(...durations) : 0
  }

  onWorkerEvent(event: LiveWorkerEvent): void {
    const session = this.session
    if (session?.id !== event.session_id) return
    switch (event.type) {
      case 'live_segment':
        this.onSegment(session, event)
        return
      case 'live_listening':
        this.deps.emit({ type: 'listening', track: event.track, active: event.active })
        return
      case 'live_lag':
        this.deps.emit({ type: 'lag', seconds: event.seconds })
        return
      case 'live_error':
        this.onWorkerError(event.code)
    }
  }

  private onSegment(
    session: Session,
    event: Extract<LiveWorkerEvent, { type: 'live_segment' }>
  ): void {
    const segment = { start: event.start, end: event.end, text: event.text }
    const { itemId } = session
    if (itemId) {
      session.writes = session.writes.then(() =>
        this.deps.history
          .appendSegment(itemId, { ...segment, speaker: event.track })
          .catch((error: unknown) => {
            this.deps.logger.error(`[ao vivo] trecho não gravado: ${String(error)}`)
          })
      )
    }
    this.deps.emit({ type: 'segment', track: event.track, ...segment })
  }

  private onWorkerError(code: string): void {
    this.deps.emit({ type: 'error', code: isErrorCode(code) ? code : 'INTERNAL' })
    if (RELOADABLE.has(code)) {
      this.deps.queue.reloadLiveOnCpu().catch((error: unknown) => {
        this.deps.logger.error(`[ao vivo] não foi possível recarregar o modelo: ${String(error)}`)
      })
    }
  }

  /** Sessões que caíram com o app: os WAV viram m4a e o item fica "Interrompida". */
  async recover(): Promise<void> {
    const { entries } = await this.deps.history.list()
    for (const meta of entries.filter((e) => e.kind === 'live' && e.status !== 'done')) {
      try {
        await this.recoverItem(meta)
      } catch (error) {
        // Um item quebrado não pode impedir os outros (nem tentar de novo a cada abertura).
        this.deps.logger.error(`[ao vivo] não foi possível recuperar ${meta.id}: ${String(error)}`)
        this.deps.onItem(await this.fail(meta.id, error))
      }
    }
  }

  private async recoverItem(meta: HistoryMeta): Promise<void> {
    const dir = this.deps.history.paths(meta.id).dir
    const tracks = (await readdir(dir))
      .map((name) => /^live-(voce|outros)\.wav$/.exec(name)?.[1] as Track | undefined)
      .filter((track): track is Track => track !== undefined)
    if (tracks.length === 0) return
    const duration = await this.finalizeFiles(meta.id, tracks)
    await this.deps.history.finalizeLive(meta.id)
    this.deps.onItem(await this.deps.history.update(meta.id, { status: 'interrupted', duration }))
  }

  private setState(state: LiveState, test: boolean, itemId: string | null): void {
    this.state = state
    this.deps.emit({ type: 'state', state, test, itemId })
  }
}
