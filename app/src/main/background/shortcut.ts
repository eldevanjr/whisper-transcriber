import type { ShortcutStatus } from '../../shared/ipc'
import type { Logger } from '../worker/supervisor'

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutDeps {
  globalShortcut: GlobalShortcutLike
  onPress(): void
  /** No Wayland quem registra é o portal do sistema; recusa não é "outro programa". */
  wayland: boolean
  logger: Logger
}

/** Atalho global de começar/parar. Suspenso enquanto a tela grava um atalho novo. */
export class Shortcuts {
  status: ShortcutStatus = 'off'
  active: string | null = null
  private wanted: string | null = null
  private suspended = false

  constructor(private readonly deps: ShortcutDeps) {}

  apply(accelerator: string | null): ShortcutStatus {
    this.wanted = accelerator
    this.release()
    if (accelerator === null) return (this.status = 'off')
    if (this.suspended) return this.status
    const ok = this.register(accelerator)
    if (ok) this.active = accelerator
    this.status = ok ? 'ok' : this.deps.wayland ? 'unavailable' : 'taken'
    return this.status
  }

  suspend(on: boolean): void {
    if (on === this.suspended) return
    this.suspended = on
    if (on) this.release()
    else this.apply(this.wanted)
  }

  private register(accelerator: string): boolean {
    try {
      return this.deps.globalShortcut.register(accelerator, () => {
        this.deps.onPress()
      })
    } catch (error) {
      this.deps.logger.warn(`[atalho] ${accelerator} recusado: ${String(error)}`)
      return false
    }
  }

  private release(): void {
    if (this.active !== null) this.deps.globalShortcut.unregister(this.active)
    this.active = null
  }
}
