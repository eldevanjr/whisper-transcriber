import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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

// Estado inicial não alarmante: a gravação é disparada sem bloquear a abertura, então a tela não
// deve piscar "Com problema" antes de a primeira gravação terminar. Só falha real vira `ok: false`.
let lastStatus: LauncherStatus = { ok: true, error: null }

/** Estado da última gravação; a tela de IAs (Task 11) mostra "Com problema" quando falha. */
export function launcherStatus(): LauncherStatus {
  return lastStatus
}

/**
 * Decide o executável que o lançador chama (spec §6): AppImage usa `$APPIMAGE` (o arquivo, não o
 * ponto de montagem); empacotado usa `process.execPath`; em desenvolvimento, o Electron do projeto
 * com o diretório do app.
 *
 * O argumento do dev é o diretório do app (`appPath`, o de `package.json`), não o bundle: passando
 * `out/main/index.js` o Electron usaria `out/main` como app e leria outro userData ("Electron"),
 * quebrando o requisito do processo MCP de achar `settings.json`/`history` do app de verdade.
 */
export function launcherTarget(input: LauncherTargetInput): LauncherTarget {
  if (!input.isPackaged) {
    return {
      command: devElectron(input.appPath, input.platform),
      args: [input.appPath]
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
 * mtime. No POSIX, se o conteúdo é o mesmo mas o bit de execução se perdeu (backup/cópia, morte
 * entre o rename e o chmod), restaura o modo sem mexer no mtime. O erro é guardado em
 * `launcherStatus()` e propagado para o log (o app segue normal).
 */
export async function writeLauncher(
  paths: AppPaths,
  target: LauncherTarget,
  platform: NodeJS.Platform
): Promise<void> {
  const content = launcherScript(target, platform)
  const posix = platform !== 'win32'
  try {
    if (await isCurrent(paths.mcpLauncher, content)) {
      const mode = ((await stat(paths.mcpLauncher)).mode & 0o777) === LAUNCHER_MODE
      if (posix && !mode) await chmod(paths.mcpLauncher, LAUNCHER_MODE)
      lastStatus = { ok: true, error: null }
      return
    }
    await mkdir(paths.mcpDir, { recursive: true, mode: 0o700 })
    if (posix) await writeExecutableAtomic(paths.mcpLauncher, content)
    else await writeFileAtomic(paths.mcpLauncher, content)
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

/** Escreve o temporário já com 0755 e só então renomeia: o lançador nunca existe sem o bit. */
async function writeExecutableAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await chmod(temporary, LAUNCHER_MODE)
  await rename(temporary, path)
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
