import { APP_NAME, REPOSITORY_URL } from './app-info'
import type { ErrorInfo } from './errors'
import type { AppInfo } from './ipc'
import type { Settings } from './settings'

// Nomes de conta no Linux/macOS não têm espaços; no Windows podem ter.
const HOME_PATTERNS = [
  /\/home\/[^/\s]+(?=\/)/g,
  /\/Users\/[^/\s]+(?=\/)/g,
  /[a-z]:[\\/]users[\\/][^\\/\n]+(?=[\\/])/gi
]

/** Troca a pasta pessoal por `~` para o diagnóstico não expor o nome do usuário. */
export function scrubPaths(text: string): string {
  return HOME_PATTERNS.reduce((result, pattern) => result.replace(pattern, '~'), text)
}

export interface DiagnosticInput {
  error: ErrorInfo
  appInfo: AppInfo | null
  settings: Settings | null
  userAgent: string
}

function describeApp(appInfo: AppInfo | null): string {
  return appInfo ? `${APP_NAME} ${appInfo.version} (${appInfo.platform})` : `${APP_NAME} ? (?)`
}

function describeSettings(settings: Settings | null): string {
  if (!settings) return 'Modelo: ? · Dispositivo: ? · Idioma do áudio: ?'
  const model = settings.model ?? '?'
  return `Modelo: ${model} · Dispositivo: ${settings.device} · Idioma do áudio: ${settings.audioLanguage}`
}

export function buildDiagnostic(input: DiagnosticInput): string {
  const { error } = input
  const lines = [
    describeApp(input.appInfo),
    `Erro: ${error.code} — ${error.message}`,
    ...(error.detail === undefined ? [] : [`Detalhe: ${error.detail}`]),
    describeSettings(input.settings),
    `Navegador: ${input.userAgent}`
  ]
  return scrubPaths(lines.join('\n'))
}

/** O GitHub recusa URLs muito longas; ~8 mil caracteres é o limite prático. */
export const ISSUE_URL_MAX = 8000

function issueUrl(title: string, diagnostic: string): string {
  const body = `**O que você estava fazendo?**\n\n\n**Diagnóstico**\n\`\`\`\n${diagnostic}\n\`\`\`\n`
  const params = new URLSearchParams({ title, labels: 'bug', body })
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`
}

/** Link para abrir, no navegador, uma issue já preenchida (o usuário revisa antes de enviar). */
export function buildIssueUrl(title: string, diagnostic: string): string {
  let text = diagnostic
  let url = issueUrl(title, text)
  while (url.length > ISSUE_URL_MAX) {
    text = `${text.slice(0, text.length - Math.max(100, url.length - ISSUE_URL_MAX) - 1)}…`
    url = issueUrl(title, text)
  }
  return url
}
