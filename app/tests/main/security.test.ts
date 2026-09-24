import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  applyCsp,
  CSP,
  hardenWebContents,
  isAllowedExternalUrl,
  isAllowedNavigation,
  isTrustedSender
} from '../../src/main/security'

describe('CSP', () => {
  it('não permite eval nem scripts externos, e libera app-media para o player', () => {
    expect(CSP).toContain("script-src 'self'")
    expect(CSP).not.toContain('unsafe-eval')
    expect(CSP).toContain('media-src app-media:')
    expect(CSP).toContain("object-src 'none'")
  })

  it('applyCsp injeta o cabeçalho em todas as respostas', () => {
    let listener:
      | ((d: { responseHeaders?: Record<string, string[]> }, cb: (r: unknown) => void) => void)
      | undefined
    const session = {
      webRequest: {
        onHeadersReceived: (l: typeof listener) => {
          listener = l
        }
      }
    } as unknown as Pick<Session, 'webRequest'>
    applyCsp(session)
    const callback = vi.fn()
    listener!({ responseHeaders: { 'X-Outro': ['1'] } }, callback)
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { 'X-Outro': ['1'], 'Content-Security-Policy': [CSP] }
    })
  })
})

describe('isAllowedExternalUrl', () => {
  it.each([
    ['https://github.com/eldevanjr', true],
    ['https://github.com/eldevanjr/whisper-transcriber/releases/tag/v1.0.0', true],
    ['https://docs.nvidia.com/cuda/eula/index.html', true],
    ['https://ffmpeg.org/download.html', true],
    ['https://huggingface.co/Systran/faster-whisper-medium', true],
    ['http://github.com/eldevanjr', false],
    ['https://github.com/outra-pessoa', false],
    ['https://github.com/eldevanjrfake/repo', false],
    ['https://github.com@evil.example/eldevanjr/', false],
    ['https://user:senha@github.com/eldevanjr/', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['não é url', false]
  ])('%s → %s', (url, expected) => {
    expect(isAllowedExternalUrl(url)).toBe(expected)
  })

  it('aceita URLs exatas extras (ex.: páginas das licenças)', () => {
    const extra = new Set(['https://www.electronjs.org/'])
    expect(isAllowedExternalUrl('https://www.electronjs.org/', extra)).toBe(true)
    expect(isAllowedExternalUrl('https://www.electronjs.org/outra', extra)).toBe(false)
  })

  it('abre só as páginas de permissão do microfone do macOS e do Windows', () => {
    expect(
      isAllowedExternalUrl(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      )
    ).toBe(true)
    expect(isAllowedExternalUrl('ms-settings:privacy-microphone')).toBe(true)
    expect(isAllowedExternalUrl('ms-settings:windowsupdate')).toBe(false)
    expect(isAllowedExternalUrl('x-apple.systempreferences:com.apple.preference.security')).toBe(
      false
    )
  })
})

describe('isTrustedSender', () => {
  const mainFrame = { processId: 4, routingId: 1 }
  const contents = { mainFrame }

  it('aceita só o frame principal da janela do app, comparando identidade e não URL', () => {
    // Pasta com [ ] e % : o Chromium e o pathToFileURL escrevem a URL de jeitos diferentes.
    const frame = { processId: 4, routingId: 1, url: 'file:///opt/[y]%20100%%20/index.html' }
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, contents)).toBe(true)
  })

  it('recusa outra janela, subframes, frame nulo e janela já fechada', () => {
    const frame = { processId: 4, routingId: 1, url: '' }
    expect(isTrustedSender({ sender: {}, senderFrame: frame }, contents)).toBe(false)
    const sub = { processId: 4, routingId: 2, url: '' }
    expect(isTrustedSender({ sender: contents, senderFrame: sub }, contents)).toBe(false)
    const other = { processId: 5, routingId: 1, url: '' }
    expect(isTrustedSender({ sender: contents, senderFrame: other }, contents)).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: null }, contents)).toBe(false)
    expect(isTrustedSender({ sender: contents, senderFrame: frame }, null)).toBe(false)
  })
})

describe('isAllowedNavigation', () => {
  it('em dev só aceita a mesma origem do servidor do Vite', () => {
    const dev = 'http://localhost:5173'
    expect(isAllowedNavigation('http://localhost:5173/#/historico', dev)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173.evil.com/', dev)).toBe(false)
    expect(isAllowedNavigation('http://localhost:51730/', dev)).toBe(false)
    expect(isAllowedNavigation('não é url', dev)).toBe(false)
  })

  it('empacotado não navega para lugar nenhum (o app é uma página só)', () => {
    expect(isAllowedNavigation('file:///opt/app/out/renderer/index.html', undefined)).toBe(false)
    expect(isAllowedNavigation('file:///etc/passwd', undefined)).toBe(false)
  })
})

describe('hardenWebContents', () => {
  function fakeContents() {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    let openHandler: ((details: { url: string }) => { action: string }) | undefined
    const contents = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
      },
      setWindowOpenHandler: (handler: typeof openHandler) => {
        openHandler = handler
      }
    } as unknown as WebContents
    return { contents, handlers, open: (url: string) => openHandler!({ url }) }
  }

  it('bloqueia navegação para fora do app, webviews e novas janelas', () => {
    const { contents, handlers, open } = fakeContents()
    const openExternal = vi.fn()
    hardenWebContents(contents, {
      isAllowedNavigation: (url) => url.startsWith('file:///app'),
      isAllowedExternal: (url) => url.startsWith('https://github.com/eldevanjr'),
      openExternal
    })
    const blocked = { preventDefault: vi.fn() }
    handlers.get('will-navigate')!(blocked, 'https://evil.example')
    expect(blocked.preventDefault).toHaveBeenCalled()
    const allowed = { preventDefault: vi.fn() }
    handlers.get('will-navigate')!(allowed, 'file:///app/index.html')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    const webview = { preventDefault: vi.fn() }
    handlers.get('will-attach-webview')!(webview)
    expect(webview.preventDefault).toHaveBeenCalled()
    expect(open('https://github.com/eldevanjr')).toEqual({ action: 'deny' })
    expect(open('https://evil.example')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://github.com/eldevanjr')
  })
})
