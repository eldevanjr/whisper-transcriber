import { formatAccelerator } from '../../shared/accelerator'
import type { LiveEvent, LiveState, QueueEvent } from '../../shared/events'
import type { HistoryMeta } from '../../shared/history'
import type {
  BackgroundCommand,
  BackgroundReport,
  LiveStartInput,
  NavigateTarget
} from '../../shared/ipc'
import { clientDisplayName } from '../../shared/mcp'
import type { Logger } from '../worker/supervisor'
import type { Flags } from './flags'
import type { TrayState } from './state'
import type { Translate } from './texts'

export const QUIT_TIMEOUT_MS = 15_000

export interface BackgroundDeps {
  live: { readonly state: LiveState; stop(): Promise<unknown> }
  queueIdle(): boolean
  /** Onboarding concluído (há modelo escolhido). */
  ready(): boolean
  command(command: BackgroundCommand): void
  view: { render(state: TrayState, t: Translate): void }
  notify(title: string, body: string, target: NavigateTarget): void
  badge(active: boolean, description: string): void
  /** Atalho registrado agora. */
  shortcut(): string | null
  windowFocused(): boolean
  /** "Avisar quando uma IA pedir transcrição" (Configurações → IAs). */
  notifyAi(): boolean
  translate(): Translate
  flags: { get(): Flags; set(patch: Partial<Flags>): Promise<void> }
  quit(): void
  platform: string
  logger: Logger
}

const isActive = (state: LiveState): boolean => state === 'recording' || state === 'paused'
/** Fim de um item da fila: avisa a IA que pediu (cancelado encerra sem aviso). */
const FINAL: ReadonlySet<string> = new Set(['done', 'failed', 'canceled'])

/**
 * O app em segundo plano: bandeja, atalho, badge e notificações a partir do ao vivo. Começar e
 * parar passam pelo renderer (é lá que está o microfone); aqui ficam as regras e o relógio.
 */
export class BackgroundController {
  private live: LiveState = 'idle'
  private test = false
  private itemId: string | null = null
  private startedAt = 0
  private pausedAt: number | null = null
  private pausedMs = 0
  private aiUnseen = false
  private timer: ReturnType<typeof setInterval> | null = null
  private quitPromise: Promise<void> | null = null
  /** Itens pedidos por IA já avisados, esperando o fim para avisar de novo. */
  private readonly aiRequests = new Set<string>()

  constructor(private readonly deps: BackgroundDeps) {}

  toggle(): void {
    const { state } = this.deps.live
    if (state === 'starting' || state === 'stopping') return
    if (state === 'idle' && !this.canStart()) return
    this.deps.command({ action: 'toggle' })
  }

  pause(): void {
    this.deps.command({ action: 'pause' })
  }

  resume(): void {
    this.deps.command({ action: 'resume' })
  }

  onStarted(input: LiveStartInput): void {
    if (input.test || this.deps.windowFocused()) return
    const t = this.deps.translate()
    const body = t(
      input.tracks.includes('outros') ? 'background.tracksBoth' : 'background.tracksMic'
    )
    this.deps.notify(t('background.started'), body, { kind: 'live' })
  }

  onLiveEvent(event: LiveEvent): void {
    if (event.type !== 'state') return
    this.live = event.state
    this.test = event.test
    if (!event.test) this.track(event.state, event.itemId)
    this.render()
  }

  onItem(meta: HistoryMeta): void {
    if (meta.id !== this.itemId || (meta.status !== 'done' && meta.status !== 'failed')) return
    this.itemId = null
    const t = this.deps.translate()
    const target: NavigateTarget = { kind: 'item', id: meta.id }
    if (meta.status === 'failed') {
      this.deps.notify(t('background.failed'), meta.fileName, target)
      return
    }
    if (this.deps.windowFocused()) return
    const minutes = Math.max(1, Math.round((meta.duration ?? 0) / 60))
    this.deps.notify(
      t('background.saved'),
      t('background.savedBody', { title: meta.fileName, minutes }),
      target
    )
  }

  /** Fila: pedido de transcrição de uma IA (MCP) e o fim dele viram notificação. */
  onQueueEvent(event: QueueEvent): void {
    if (event.type !== 'job' || event.meta.requestedBy === undefined || !this.deps.notifyAi())
      return
    const { meta } = event
    if (meta.status === 'queued') this.onAiRequested(meta, event.meta.requestedBy)
    else if (this.aiRequests.has(meta.id) && FINAL.has(meta.status)) {
      this.aiRequests.delete(meta.id)
      this.onAiFinished(meta, clientDisplayName(event.meta.requestedBy))
    }
  }

  report(report: BackgroundReport): void {
    const t = this.deps.translate()
    if (report.kind === 'deviceLost') {
      this.deps.notify(t('background.deviceLost'), t('background.deviceLostBody'), { kind: 'live' })
      return
    }
    this.deps.notify(t('background.startFailed'), t(`errors.${report.error.code}`), {
      kind: 'live'
    })
  }

  onWindowHidden(): void {
    if (this.deps.flags.get().hiddenHintShown) return
    void this.deps.flags.set({ hiddenHintShown: true }).catch((error: unknown) => {
      this.deps.logger.warn(`[bandeja] state.json: ${String(error)}`)
    })
    const t = this.deps.translate()
    const shortcut = this.snapshot().shortcut
    const body = shortcut
      ? t('background.hiddenBody', { shortcut: formatAccelerator(shortcut, this.deps.platform) })
      : t('background.hiddenBodyNoShortcut')
    this.deps.notify(t('background.hiddenTitle'), body, { kind: 'window' })
  }

  onWindowShown(): void {
    this.aiUnseen = false
    this.render()
  }

  /** Para o MCP: transcrição pedida por uma IA que a pessoa ainda não viu. */
  markAiUnseen(): void {
    this.aiUnseen = true
    this.render()
  }

  refresh(): void {
    this.render()
  }

  snapshot(): TrayState {
    return {
      live: this.live,
      test: this.test,
      elapsed: this.elapsed(),
      ready: this.deps.ready(),
      shortcut: this.deps.shortcut(),
      aiUnseen: this.aiUnseen,
      platform: this.deps.platform
    }
  }

  /** "Sair": finaliza a gravação (com limite) antes de encerrar; o recover() cobre o que sobrar. */
  quit(): Promise<void> {
    // Idempotente: um "Sair" enquanto a finalização já está em andamento espera a mesma promessa.
    this.quitPromise ??= this.runQuit()
    return this.quitPromise
  }

  private async runQuit(): Promise<void> {
    if (this.deps.live.state !== 'idle') {
      const stop = this.deps.live.stop().catch((error: unknown) => {
        this.deps.logger.error(`[bandeja] parar ao sair falhou: ${String(error)}`)
      })
      await Promise.race([stop, new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))])
    }
    this.deps.quit()
  }

  private onAiRequested(meta: HistoryMeta, requestedBy: string): void {
    if (this.aiRequests.has(meta.id)) return
    this.aiRequests.add(meta.id)
    const t = this.deps.translate()
    const client = clientDisplayName(requestedBy)
    this.deps.notify(t('background.aiRequested', { client }), meta.fileName, {
      kind: 'item',
      id: meta.id
    })
    if (!this.deps.windowFocused()) this.markAiUnseen()
  }

  private onAiFinished(meta: HistoryMeta, client: string): void {
    const t = this.deps.translate()
    const target: NavigateTarget = { kind: 'item', id: meta.id }
    if (meta.status === 'done') {
      const minutes = Math.max(1, Math.round((meta.duration ?? 0) / 60))
      this.deps.notify(
        t('background.aiDone', { client }),
        t('background.savedBody', { title: meta.fileName, minutes }),
        target
      )
    } else if (meta.status === 'failed') {
      const reason = t(`errors.${meta.error?.code ?? 'INTERNAL'}`)
      this.deps.notify(
        t('background.aiFailed', { client }),
        t('background.aiFailedBody', { title: meta.fileName, reason }),
        target
      )
    }
  }

  private canStart(): boolean {
    const t = this.deps.translate()
    if (!this.deps.ready()) {
      this.deps.notify(t('background.startFailed'), t('background.setupFirst'), { kind: 'window' })
      return false
    }
    if (!this.deps.queueIdle()) {
      this.deps.notify(t('background.startFailed'), t('errors.QUEUE_BUSY'), { kind: 'live' })
      return false
    }
    return true
  }

  private track(now: LiveState, itemId: string | null): void {
    if (now === 'recording' && this.timer === null) this.begin(itemId)
    else if (now === 'paused' && this.pausedAt === null) this.pausedAt = Date.now()
    else if (now === 'recording' && this.pausedAt !== null) {
      this.pausedMs += Date.now() - this.pausedAt
      this.pausedAt = null
    } else if (now === 'idle') this.end()
  }

  private begin(itemId: string | null): void {
    this.itemId = itemId
    this.startedAt = Date.now()
    this.pausedMs = 0
    this.pausedAt = null
    this.timer = setInterval(() => {
      this.render()
    }, 1000)
  }

  private end(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.pausedAt = null
  }

  private elapsed(): number {
    if (!isActive(this.live) || this.test) return 0
    const paused = this.pausedMs + (this.pausedAt === null ? 0 : Date.now() - this.pausedAt)
    return Math.floor((Date.now() - this.startedAt - paused) / 1000)
  }

  private render(): void {
    const state = this.snapshot()
    const t = this.deps.translate()
    this.deps.view.render(state, t)
    this.deps.badge(isActive(state.live) && !state.test, t('background.recording'))
  }
}
