import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError, type ErrorCode } from '../../shared/errors'
import type { Device } from '../../shared/settings'
import type { WorkerCommandLine } from './locate'
import {
  errorFromEvent,
  LineSplitter,
  parseWorkerEvent,
  PROTOCOL_VERSION,
  serializeCommand,
  type JobEvent,
  type WorkerCommand,
  type WorkerEvent,
  type LiveWorkerEvent
} from './protocol'

export interface ChildLike {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(): boolean
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string }
) => ChildLike

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface RequestOptions {
  device?: Device
  onEvent?: (event: JobEvent) => void
}

export interface WorkerPort {
  request(command: WorkerCommand, options?: RequestOptions): Promise<Record<string, unknown>>
  kill(): void
}

export interface SupervisorOptions {
  spawn: SpawnFn
  commandLine: WorkerCommandLine
  envFor: (device: Device) => NodeJS.ProcessEnv
  expectedVersion: string
  logger: Logger
  heartbeatTimeoutMs?: number
  readyTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Eventos da sessão ao vivo (não pertencem a um job da fila). */
  onLiveEvent?: (event: LiveWorkerEvent) => void
}

export const MAX_RESTARTS = 3

const isLiveEvent = (event: WorkerEvent): event is LiveWorkerEvent => event.type.startsWith('live_')
export const RESTART_WINDOW_MS = 60_000

type StopReason = 'canceled' | 'timeout' | 'crash' | 'mismatch'

const STOP_ERRORS: Record<StopReason, [ErrorCode, string]> = {
  canceled: ['CANCELED', 'Transcrição cancelada'],
  timeout: ['WORKER_TIMEOUT', 'O motor de transcrição parou de responder'],
  crash: ['WORKER_CRASHED', 'O motor de transcrição parou inesperadamente'],
  mismatch: ['PROTOCOL_MISMATCH', 'Versão do motor incompatível com o aplicativo']
}

interface Pending {
  resolve: (data: Record<string, unknown>) => void
  reject: (error: AppError) => void
  jobId: string | null
  onEvent: ((event: JobEvent) => void) | undefined
}

interface Running {
  child: ChildLike
  device: Device
  pending: Map<string, Pending>
  reason: StopReason
  watchdog: ReturnType<typeof setTimeout> | undefined
  ready: PromiseWithResolvers<undefined>
  detached: boolean
}

export class WorkerSupervisor implements WorkerPort {
  private running: Running | null = null
  private crashes: number[] = []
  private disposed = false
  // Serializa os inícios: duas requisições durante a espera de reinício não podem criar dois processos.
  private starting: Promise<unknown> = Promise.resolve()
  private readonly heartbeatTimeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: SupervisorOptions) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? delay
  }

  async request(
    command: WorkerCommand,
    options: RequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const running = await this.ensure(options.device ?? this.running?.device ?? 'cpu')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const jobId = command.cmd === 'transcribe' ? command.params.job_id : null
      running.pending.set(id, { resolve, reject, jobId, onEvent: options.onEvent })
      running.child.stdin.write(serializeCommand(id, command))
    })
  }

  /** Sem resposta (blocos do ao vivo): só com o processo já de pé; devolve se enviou. */
  notify(command: WorkerCommand): boolean {
    const running = this.running
    if (running === null || running.detached) return false
    running.child.stdin.write(serializeCommand(randomUUID(), command))
    return true
  }

  kill(): void {
    if (this.running) this.stop(this.running, 'canceled')
  }

  /** Encerra de vez (app fechando): nenhuma requisição posterior inicia outro processo. */
  dispose(): void {
    this.disposed = true
    this.kill()
  }

  private ensure(device: Device): Promise<Running> {
    const next = this.starting.then(() => this.ensureNow(device))
    this.starting = next.catch(() => undefined)
    return next
  }

  private async ensureNow(device: Device): Promise<Running> {
    this.assertOpen()
    if (this.running && this.running.device !== device) this.stop(this.running, 'canceled')
    if (!this.running) {
      const recent = this.recentCrashes()
      if (recent >= MAX_RESTARTS) {
        throw new AppError(
          'WORKER_UNAVAILABLE',
          'O motor de transcrição não conseguiu iniciar',
          `${recent} falhas em ${RESTART_WINDOW_MS / 1000} s`
        )
      }
      if (recent > 0) await this.sleep(recent * 1000)
      this.assertOpen()
      this.running = this.spawn(device)
    }
    const running = this.running
    await running.ready.promise
    return running
  }

  private assertOpen(): void {
    if (this.disposed) throw new AppError('CANCELED', 'O aplicativo está fechando')
  }

  private recentCrashes(): number {
    const cutoff = this.now() - RESTART_WINDOW_MS
    this.crashes = this.crashes.filter((time) => time > cutoff)
    return this.crashes.length
  }

  private spawn(device: Device): Running {
    const { command, args, cwd } = this.options.commandLine
    const env = this.options.envFor(device)
    const child = this.options.spawn(command, args, cwd === undefined ? { env } : { env, cwd })
    const ready = Promise.withResolvers<undefined>()
    ready.promise.catch(() => undefined) // evita rejeição não tratada quando ninguém aguarda
    const running: Running = {
      child,
      device,
      pending: new Map(),
      reason: 'crash',
      watchdog: undefined,
      ready,
      detached: false
    }
    this.wire(running)
    this.arm(running, this.readyTimeoutMs)
    return running
  }

  private wire(running: Running): void {
    const { child } = running
    const out = new LineSplitter()
    const err = new LineSplitter()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const line of out.push(chunk)) this.onLine(running, line)
    })
    child.stderr.on('data', (chunk: string) => {
      for (const line of err.push(chunk)) this.options.logger.info(`[worker] ${line}`)
    })
    child.stdin.on('error', (error: Error) => {
      // EPIPE: o processo morreu antes de ler o comando; o 'exit' que vem a seguir rejeita a requisição.
      this.options.logger.warn(`[worker] falha ao escrever: ${error.message}`)
    })
    child.once('exit', () => {
      this.detach(running, running.reason)
    })
    child.once('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger.error(`[worker] falha ao iniciar: ${message}`)
      this.detach(running, 'crash', message)
    })
  }

  private onLine(running: Running, line: string): void {
    const event = parseWorkerEvent(line)
    if (!event) {
      this.options.logger.warn(`[worker] linha inválida: ${line.slice(0, 200)}`)
      return
    }
    this.arm(running, this.heartbeatTimeoutMs)
    this.dispatch(running, event)
  }

  private dispatch(running: Running, event: WorkerEvent): void {
    if (isLiveEvent(event)) {
      this.options.onLiveEvent?.(event)
      return
    }
    switch (event.type) {
      case 'ready':
        this.onReady(running, event.protocol, event.version)
        return
      case 'heartbeat':
        return
      case 'result':
        this.settle(running, event.id, (pending) => {
          pending.resolve(event.data)
        })
        return
      case 'error':
        this.onWorkerError(running, event)
        return
      default:
        this.forward(running, event)
    }
  }

  private onReady(running: Running, protocol: number, version: string): void {
    if (protocol === PROTOCOL_VERSION && version === this.options.expectedVersion) {
      running.ready.resolve(undefined)
      return
    }
    this.options.logger.error(
      `[worker] incompatível: protocolo ${protocol}, versão ${version} (esperado ${this.options.expectedVersion})`
    )
    this.stop(running, 'mismatch')
  }

  private onWorkerError(running: Running, event: Extract<WorkerEvent, { type: 'error' }>): void {
    if (event.id === undefined) {
      this.options.logger.warn(`[worker] erro: ${event.code} ${event.message}`)
      return
    }
    this.settle(running, event.id, (pending) => {
      pending.reject(errorFromEvent(event))
    })
  }

  private settle(running: Running, id: string, action: (pending: Pending) => void): void {
    const pending = running.pending.get(id)
    if (!pending) {
      this.options.logger.warn(`[worker] resposta sem requisição: ${id}`)
      return
    }
    running.pending.delete(id)
    action(pending)
  }

  private forward(running: Running, event: JobEvent): void {
    for (const pending of running.pending.values()) {
      if (pending.jobId === event.job_id) pending.onEvent?.(event)
    }
  }

  private arm(running: Running, ms: number): void {
    clearTimeout(running.watchdog)
    running.watchdog = setTimeout(() => {
      this.options.logger.error('[worker] sem sinal de vida; reiniciando')
      this.stop(running, 'timeout')
    }, ms)
  }

  private stop(running: Running, reason: StopReason): void {
    running.reason = reason
    running.child.kill()
    this.detach(running, reason)
  }

  private detach(running: Running, reason: StopReason, detail?: string): void {
    if (running.detached) return
    running.detached = true
    clearTimeout(running.watchdog)
    // Só o processo atual chega aqui sem estar desligado: quem o substitui chama stop() antes.
    this.running = null
    if (reason !== 'canceled') this.crashes.push(this.now())
    const [code, message] = STOP_ERRORS[reason]
    const error = new AppError(code, message, detail)
    for (const pending of running.pending.values()) pending.reject(error)
    running.pending.clear()
    running.ready.reject(error)
  }
}
