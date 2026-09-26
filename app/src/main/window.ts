import type { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences } from 'electron'
import { APP_NAME } from '../shared/app-info'
import { hardenWebContents, type HardenOptions } from './security'

export type BrowserWindowCtor = new (options: BrowserWindowConstructorOptions) => BrowserWindow

export function secureWebPreferences(preloadPath: string, isDev: boolean): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    // Escondida na bandeja o ao vivo segue gravando: a captura e os timers não podem desacelerar.
    backgroundThrottling: false,
    devTools: isDev
  }
}

export interface MainWindowOptions extends HardenOptions {
  BrowserWindowCtor: BrowserWindowCtor
  preloadPath: string
  isDev: boolean
  /** Tema escuro em uso: o fundo da janela antes de pintar acompanha a tela de carregamento. */
  dark: boolean
  /** Ícone da janela (Linux; no Windows/macOS vem do executável/bundle). */
  icon?: string
  /** Aberta pelo login: carrega escondida na bandeja. */
  startHidden?: boolean
}

export interface TrayWindowLike {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  hide(): void
}

/**
 * A pessoa está olhando o app: visível e em foco. Só o foco não basta — no Linux a janela
 * escondida na bandeja continua dizendo que tem foco.
 */
export function isWindowInView(
  window: { isVisible(): boolean; isFocused(): boolean } | null
): boolean {
  return window !== null && window.isVisible() && window.isFocused()
}

/** Fechar a janela esconde na bandeja; "Sair" (ou a opção desligada) fecha de verdade. */
export function keepInTray(
  window: TrayWindowLike,
  options: { shouldHide(): boolean; onHidden(): void }
): void {
  window.on('close', (event) => {
    if (!options.shouldHide()) return
    event.preventDefault()
    window.hide()
    options.onHidden()
  })
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new options.BrowserWindowCtor({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: options.dark ? '#0A0A0B' : '#EEF2F7',
    autoHideMenuBar: true,
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: secureWebPreferences(options.preloadPath, options.isDev)
  })
  hardenWebContents(window.webContents, options)
  // Fechada (escondida na bandeja) antes do primeiro quadro: o "pronta" que chega depois não a
  // traz de volta.
  let closed = false
  window.on('close', () => {
    closed = true
  })
  window.once('ready-to-show', () => {
    if (!options.startHidden && !closed) window.show()
  })
  window.webContents.on('render-process-gone', () => {
    window.reload()
  })
  return window
}
