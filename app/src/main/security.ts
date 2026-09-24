import type { Session, WebContents } from 'electron'
import { AUTHOR_GITHUB_URL } from '../shared/app-info'

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  'media-src app-media:',
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const EXTERNAL_PREFIXES = [
  `${AUTHOR_GITHUB_URL}/`,
  'https://docs.nvidia.com/',
  'https://www.nvidia.com/',
  'https://ffmpeg.org/',
  'https://huggingface.co/'
]

export function isAllowedExternalUrl(url: string, extra: ReadonlySet<string> = new Set()): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
  const { href } = parsed
  return (
    href === AUTHOR_GITHUB_URL ||
    extra.has(href) ||
    EXTERNAL_PREFIXES.some((prefix) => href.startsWith(prefix))
  )
}

export interface FrameLike {
  readonly processId: number
  readonly routingId: number
}

export interface SenderEvent {
  readonly sender: unknown
  readonly senderFrame: FrameLike | null
}

/**
 * Confere a identidade (janela + frame principal) em vez da URL: o Chromium e o
 * pathToFileURL codificam caracteres como `[`, `]` e `%` de jeitos diferentes.
 */
export function isTrustedSender(
  event: SenderEvent,
  contents: { readonly mainFrame: FrameLike } | null
): boolean {
  const frame = event.senderFrame
  if (contents === null || frame === null || event.sender !== contents) return false
  const { mainFrame } = contents
  return frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId
}

/** O app é uma página só: em produção nenhuma navegação é legítima; em dev, só a origem do Vite. */
export function isAllowedNavigation(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl === undefined || !URL.canParse(url)) return false
  return new URL(url).origin === new URL(devServerUrl).origin
}

export function applyCsp(session: Pick<Session, 'webRequest'>): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] }
    })
  })
}

export interface HardenOptions {
  isAllowedNavigation: (url: string) => boolean
  isAllowedExternal: (url: string) => boolean
  openExternal: (url: string) => void
}

export function hardenWebContents(contents: WebContents, options: HardenOptions): void {
  contents.on('will-navigate', (event, url) => {
    if (!options.isAllowedNavigation(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (options.isAllowedExternal(url)) options.openExternal(url)
    return { action: 'deny' }
  })
}
