import { join } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'
import { trayIconFile } from './icons'
import {
  iconState,
  menuModel,
  tooltip,
  trayTitle,
  type MenuAction,
  type MenuEntry,
  type TrayState
} from './state'
import type { Translate } from './texts'

export interface TrayLike {
  setImage(image: string): void
  setToolTip(text: string): void
  setTitle(title: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click', listener: () => void): void
}

export interface TrayViewDeps {
  tray: TrayLike
  buildMenu(template: MenuItemConstructorOptions[]): unknown
  iconDir: string
  platform: string
  onAction(action: MenuAction): void
}

/** Aplica o estado no ícone da bandeja; refaz o menu só quando ele muda (senão o menu aberto pisca). */
export class TrayView {
  private icon = ''
  private menu = ''

  constructor(private readonly deps: TrayViewDeps) {
    // Windows: clique simples abre a janela (no Linux e no macOS o clique abre o menu).
    if (deps.platform === 'win32') {
      deps.tray.on('click', () => {
        deps.onAction('open')
      })
    }
  }

  render(state: TrayState, t: Translate): void {
    const icon = join(this.deps.iconDir, trayIconFile(iconState(state), this.deps.platform))
    if (icon !== this.icon) {
      this.icon = icon
      this.deps.tray.setImage(icon)
    }
    this.deps.tray.setToolTip(tooltip(state, t))
    if (this.deps.platform === 'darwin') this.deps.tray.setTitle(trayTitle(state))
    const model = menuModel(state, t)
    const key = JSON.stringify(model)
    if (key === this.menu) return
    this.menu = key
    this.deps.tray.setContextMenu(this.deps.buildMenu(model.map((entry) => this.item(entry))))
  }

  private item(entry: MenuEntry): MenuItemConstructorOptions {
    if (entry.type === 'separator') return { type: 'separator' }
    const { action } = entry
    if (action === null) return { label: entry.label, enabled: entry.enabled }
    return {
      label: entry.label,
      enabled: entry.enabled,
      click: () => {
        this.deps.onAction(action)
      }
    }
  }
}
