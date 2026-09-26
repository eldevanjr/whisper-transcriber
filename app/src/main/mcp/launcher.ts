import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toAppError } from '../../shared/errors'
import { writeFileAtomic } from '../fs-utils'
import type { AppPaths } from '../paths'

/** Modo do lançador POSIX; os clientes MCP precisam poder executá-lo direto (spec §6). */
const LAUNCHER_MODE = 0o755

export interface LauncherTarget {
  command: string
  args: string[]
}

export interface LauncherTargetInput {
  platform: NodeJS.Platform
  execPath: string
  env: NodeJS.ProcessEnv
  isPackaged: boolean
  appPath: string
}

export interface LauncherStatus {
  ok: boolean
  error: string | null
}

let lastStatus: LauncherStatus = { ok: false, error: null }

/** Estado da última gravação; a tela de IAs (Task 11) mostra "Com problema" quando falha. */
export function launcherStatus(): LauncherStatus {
  return lastStatus
}

/**
 * Decide o executável que o lançador chama (spec §6): AppImage usa `$APPIMAGE` (o arquivo, não o
 * ponto de montagem); empacotado usa `process.execPath`; em desenvolvimento, o Electron do projeto
 * com `out/main/index.js`.
 */
export function launcherTarget(input: LauncherTargetInput): LauncherTarget {
  if (!input.isPackaged) {
    return {
      command: devElectron(input.appPath, input.platform),
      args: [join(input.appPath, 'out', 'main', 'index.js')]
    }
  }
  const appImage = input.platform === 'linux' ? input.env.APPIMAGE : undefined
  const command = appImage && appImage.length > 0 ? appImage : input.execPath
  return { command, args: [] }
}

function devElectron(appPath: string, platform: NodeJS.Platform): string {
  const dist = join(appPath, 'node_modules', 'electron', 'dist')
  if (platform === 'win32') return join(dist, 'electron.exe')
  if (platform === 'darwin') return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return join(dist, 'electron')
}

/**
 * Grava o lançador em `userData/mcp/` (spec §6), só quando o conteúdo mudou para preservar o
 * mtime. O erro é guardado em `launcherStatus()` e propagado para o log (o app segue normal).
 */
export async function writeLauncher(
  paths: AppPaths,
  target: LauncherTarget,
  platform: NodeJS.Platform
): Promise<void> {
  const content = launcherScript(target, platform)
  try {
    if (await isCurrent(paths.mcpLauncher, content)) {
      lastStatus = { ok: true, error: null }
      return
    }
    await mkdir(paths.mcpDir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(paths.mcpLauncher, content)
    if (platform !== 'win32') await chmod(paths.mcpLauncher, LAUNCHER_MODE)
    lastStatus = { ok: true, error: null }
  } catch (error) {
    lastStatus = { ok: false, error: toAppError(error).message }
    throw error
  }
}

async function isCurrent(path: string, content: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === content
  } catch {
    return false
  }
}

/** `exec "cmd" args --mcp "$@"` no POSIX e `@"cmd" args --mcp %*` no Windows (spec §6). */
function launcherScript(target: LauncherTarget, platform: NodeJS.Platform): string {
  const quote = platform === 'win32' ? quoteWindows : quotePosix
  const parts = [quote(target.command), ...target.args.map(quote), '--mcp']
  return platform === 'win32'
    ? `@${parts.join(' ')} %*\r\n`
    : `#!/bin/sh\nexec ${parts.join(' ')} "$@"\n`
}

/** Dentro de aspas duplas no `sh`, só estes caracteres precisam de barra invertida. */
function quotePosix(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`
}

/** No `cmd.exe` aspas dentro de aspas viram aspas duplas. */
function quoteWindows(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
