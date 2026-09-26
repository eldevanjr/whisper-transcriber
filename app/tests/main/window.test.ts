import type { BrowserWindowConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  createMainWindow,
  isWindowInView,
  keepInTray,
  secureWebPreferences,
  type BrowserWindowCtor
} from '../../src/main/window'

describe('secureWebPreferences', () => {
  it('liga todas as proteções e só abre DevTools em desenvolvimento', () => {
    expect(secureWebPreferences('/p/index.js', false)).toEqual({
      preload: '/p/index.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: false
    })
    expect(secureWebPreferences('/p', true).devTools).toBe(true)
  })
})

describe('createMainWindow', () => {
  it('cria a janela segura, mostra quando pronta e recarrega se o renderer cair', () => {
    const windowEvents = new Map<string, () => void>()
    const contentsEvents = new Map<string, () => void>()
    const instance = {
      show: vi.fn(),
      reload: vi.fn(),
      once: (event: string, handler: () => void) => windowEvents.set(event, handler),
      on: (event: string, handler: () => void) => windowEvents.set(event, handler),
      webContents: {
        on: (event: string, handler: () => void) => contentsEvents.set(event, handler),
        setWindowOpenHandler: vi.fn()
      }
    }
    let received: BrowserWindowConstructorOptions | undefined
    const Ctor = vi.fn(function (this: unknown, options: BrowserWindowConstructorOptions) {
      received = options
      return instance
    }) as unknown as BrowserWindowCtor
    const window = createMainWindow({
      BrowserWindowCtor: Ctor,
      preloadPath: '/p/index.js',
      isDev: false,
      dark: false,
      isAllowedNavigation: () => false,
      isAllowedExternal: () => false,
      openExternal: vi.fn()
    })
    expect(window).toBe(instance)
    expect(received).toMatchObject({ title: 'Whisper Transcriber', show: false, minWidth: 960 })
    // Fundo da janela no tom do tema: sem flash escuro no tema claro antes de pintar.
    expect(received?.backgroundColor).toBe('#EEF2F7')
    expect(received).not.toHaveProperty('icon')
    expect(received?.webPreferences?.sandbox).toBe(true)
    windowEvents.get('ready-to-show')!()
    expect(instance.show).toHaveBeenCalled()
    contentsEvents.get('render-process-gone')!()
    expect(instance.reload).toHaveBeenCalled()
    expect(contentsEvents.has('will-navigate')).toBe(true)
  })
})

describe('createMainWindow no tema escuro', () => {
  it('pinta o fundo escuro antes do conteúdo', () => {
    let received: BrowserWindowConstructorOptions | undefined
    const instance = {
      once: vi.fn(),
      on: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    }
    const Ctor = vi.fn(function (this: unknown, options: BrowserWindowConstructorOptions) {
      received = options
      return instance
    }) as unknown as BrowserWindowCtor
    createMainWindow({
      BrowserWindowCtor: Ctor,
      preloadPath: '/p/index.js',
      isDev: false,
      dark: true,
      icon: '/r/icon.png',
      isAllowedNavigation: () => false,
      isAllowedExternal: () => false,
      openExternal: vi.fn()
    })
    expect(received?.backgroundColor).toBe('#0A0A0B')
    expect(received?.icon).toBe('/r/icon.png')
  })
})

describe('createMainWindow escondida (aberta pelo login)', () => {
  it('carrega mas não mostra', () => {
    const windowEvents = new Map<string, () => void>()
    const instance = {
      show: vi.fn(),
      once: (event: string, handler: () => void) => windowEvents.set(event, handler),
      on: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    }
    const Ctor = vi.fn(function () {
      return instance
    }) as unknown as BrowserWindowCtor
    createMainWindow({
      BrowserWindowCtor: Ctor,
      preloadPath: '/p/index.js',
      isDev: false,
      dark: false,
      startHidden: true,
      isAllowedNavigation: () => false,
      isAllowedExternal: () => false,
      openExternal: vi.fn()
    })
    windowEvents.get('ready-to-show')!()
    expect(instance.show).not.toHaveBeenCalled()
  })
})

describe('createMainWindow fechada antes de ficar pronta', () => {
  it('não reaparece quando o primeiro quadro chega depois', () => {
    const windowEvents = new Map<string, () => void>()
    const instance = {
      show: vi.fn(),
      once: (event: string, handler: () => void) => windowEvents.set(event, handler),
      on: (event: string, handler: () => void) => windowEvents.set(event, handler),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    }
    const Ctor = vi.fn(function () {
      return instance
    }) as unknown as BrowserWindowCtor
    createMainWindow({
      BrowserWindowCtor: Ctor,
      preloadPath: '/p/index.js',
      isDev: false,
      dark: false,
      isAllowedNavigation: () => false,
      isAllowedExternal: () => false,
      openExternal: vi.fn()
    })
    // Fechar (esconder na bandeja) antes do "pronta": a janela não pode voltar sozinha.
    windowEvents.get('close')!()
    windowEvents.get('ready-to-show')!()
    expect(instance.show).not.toHaveBeenCalled()
  })
})

describe('keepInTray', () => {
  function setup(hide: boolean) {
    let listener: (event: { preventDefault(): void }) => void = () => undefined
    const window = {
      on: vi.fn((_event: 'close', handler: typeof listener) => {
        listener = handler
      }),
      hide: vi.fn()
    }
    const onHidden = vi.fn()
    keepInTray(window, { shouldHide: () => hide, onHidden })
    const event = { preventDefault: vi.fn() }
    listener(event)
    return { window, onHidden, event }
  }

  it('fechar esconde na bandeja', () => {
    const { window, onHidden, event } = setup(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
    expect(onHidden).toHaveBeenCalled()
  })

  it('saindo (ou opção desligada): fecha de verdade', () => {
    const { window, event } = setup(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })
})

describe('isWindowInView', () => {
  it('só conta como vista a janela visível e em foco', () => {
    const view = (visible: boolean, focused: boolean) =>
      isWindowInView({ isVisible: () => visible, isFocused: () => focused })
    expect(view(true, true)).toBe(true)
    // No Linux a janela escondida continua dizendo que tem foco.
    expect(view(false, true)).toBe(false)
    expect(view(true, false)).toBe(false)
    expect(isWindowInView(null)).toBe(false)
  })
})
