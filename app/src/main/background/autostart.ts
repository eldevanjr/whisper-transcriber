import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_NAME } from '../../shared/app-info'
import { desktopExec } from '../linux-integration'

export const HIDDEN_ARG = '--hidden'

export interface AutostartDeps {
  platform: string
  isPackaged: boolean
  app: {
    setLoginItemSettings(settings: {
      openAtLogin: boolean
      openAsHidden?: boolean
      args?: string[]
    }): void
  }
  env: Record<string, string | undefined>
  home: string
  execPath: string
}

function autostartEntry(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    `Exec=${desktopExec(exec)} ${HIDDEN_ARG}`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

async function linux(enabled: boolean, deps: AutostartDeps): Promise<void> {
  const dir = join(deps.env.XDG_CONFIG_HOME ?? join(deps.home, '.config'), 'autostart')
  const file = join(dir, 'whisper-transcriber.desktop')
  if (!enabled) return rm(file, { force: true })
  await mkdir(dir, { recursive: true })
  // Regravado a cada início: o AppImage pode ter mudado de lugar depois de atualizar.
  await writeFile(file, autostartEntry(deps.env.APPIMAGE ?? deps.execPath), 'utf8')
}

/** Abrir escondido na bandeja ao entrar no computador. Em desenvolvimento, nada. */
export async function applyAutostart(enabled: boolean, deps: AutostartDeps): Promise<void> {
  if (!deps.isPackaged) return
  if (deps.platform === 'linux') return linux(enabled, deps)
  deps.app.setLoginItemSettings(
    deps.platform === 'darwin'
      ? { openAtLogin: enabled, openAsHidden: true }
      : { openAtLogin: enabled, args: [HIDDEN_ARG] }
  )
}

/** Aberto pelo login: a janela carrega, mas não aparece. */
export function openedHidden(
  argv: readonly string[],
  platform: string,
  loginItem: () => { wasOpenedAtLogin?: boolean }
): boolean {
  return (
    argv.includes(HIDDEN_ARG) || (platform === 'darwin' && loginItem().wasOpenedAtLogin === true)
  )
}
