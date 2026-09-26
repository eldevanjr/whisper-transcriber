import type { NavigateTarget } from '../../shared/ipc'
import type { Logger } from '../worker/supervisor'

export interface NotificationLike {
  on(event: 'click' | 'close', listener: () => void): void
  show(): void
}

export interface NotificationCtor {
  new (options: { title: string; body: string; icon?: string }): NotificationLike
  isSupported(): boolean
}

export interface NotifierDeps {
  Notification: NotificationCtor
  open(target: NavigateTarget): void
  /** Linux: o ícone do app (no Windows e no macOS vem do executável). */
  icon?: string
  logger: Logger
}

/** Notificação nativa (central do GNOME, do Windows e do macOS); clicar abre a janela no destino. */
export class Notifier {
  // Guardadas até fechar: sem referência o coletor de lixo leva o objeto e o clique se perde.
  private readonly alive = new Set<NotificationLike>()

  constructor(private readonly deps: NotifierDeps) {}

  show(title: string, body: string, target: NavigateTarget): void {
    this.deps.logger.info(`[notificação] ${title} — ${body}`)
    if (!this.deps.Notification.isSupported()) return
    const icon = this.deps.icon
    const notification = new this.deps.Notification({ title, body, ...(icon ? { icon } : {}) })
    this.alive.add(notification)
    notification.on('click', () => {
      this.alive.delete(notification)
      this.deps.open(target)
    })
    notification.on('close', () => {
      this.alive.delete(notification)
    })
    notification.show()
  }
}
