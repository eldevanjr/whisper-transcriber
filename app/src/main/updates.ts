import { z } from 'zod'
import type { UpdateEvent, UpdateInfo } from '../shared/events'
import type { FetchFn } from './downloads/http'

export const RELEASES_URL =
  'https://api.github.com/repos/eldevanjr/whisper-transcriber/releases/latest'
export const RELEASES_PAGE = 'https://github.com/eldevanjr/whisper-transcriber/releases/latest'

const ReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().startsWith('https://')
})

/** Compara só a parte numérica: o sufixo de pré-release (0.0.0-dev) é ignorado. */
export function compareVersions(a: string, b: string): number {
  const numbers = (version: string) => version.replace(/-.*/, '').split('.').map(Number)
  const left = numbers(a)
  const right = numbers(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

export async function checkForUpdate(
  currentVersion: string,
  fetchFn: FetchFn
): Promise<UpdateInfo | null> {
  try {
    const response = await fetchFn(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!response.ok) return null
    const parsed = ReleaseSchema.safeParse(await response.json())
    if (!parsed.success) return null
    const latest = parsed.data.tag_name.replace(/^v/, '')
    return {
      available: compareVersions(latest, currentVersion) > 0,
      latest,
      url: parsed.data.html_url,
      mode: 'link'
    }
  } catch {
    return null
  }
}

/**
 * Atualização automática só onde não exige assinatura (spec §10.7): Windows (NSIS) e AppImage.
 * O .deb depende do gerenciador de pacotes e o macOS sem assinatura não aplica a atualização.
 */
export function canAutoUpdate(platform: string, env: NodeJS.ProcessEnv): boolean {
  return platform === 'win32' || (platform === 'linux' && Boolean(env.APPIMAGE))
}

/** O que o app usa do `autoUpdater` do electron-updater. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  quitAndInstall(): void
}

export interface UpdaterDeps {
  platform: string
  env: NodeJS.ProcessEnv
  version: string
  fetch: FetchFn
  /** Tardio: o electron-updater só é carregado onde a atualização automática vale. */
  autoUpdater: () => AutoUpdaterLike
  emit: (event: UpdateEvent) => void
}

export interface Updater {
  check(): Promise<UpdateInfo | null>
  install(): void
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const auto = canAutoUpdate(deps.platform, deps.env)
  let updater: AutoUpdaterLike | null = null

  const configured = (): AutoUpdaterLike => {
    if (updater) return updater
    updater = deps.autoUpdater()
    // Baixa em segundo plano (o SHA-512 do latest*.yml é conferido) e aplica ao fechar, se o
    // usuário não reiniciar antes pelo aviso.
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('update-downloaded', (info) => {
      deps.emit({ type: 'ready', version: info.version })
    })
    return updater
  }

  const checkAuto = async (): Promise<UpdateInfo> => {
    const result = await configured().checkForUpdates()
    const latest = result?.updateInfo.version ?? deps.version
    return {
      available: compareVersions(latest, deps.version) > 0,
      latest,
      url: RELEASES_PAGE,
      mode: 'auto'
    }
  }

  return {
    async check() {
      if (auto) {
        try {
          return await checkAuto()
        } catch {
          // sem latest.yml, rede instável…: o aviso com link ainda funciona
        }
      }
      return checkForUpdate(deps.version, deps.fetch)
    },
    install() {
      updater?.quitAndInstall()
    }
  }
}
