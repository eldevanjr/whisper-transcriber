import { execFile as nodeExecFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { AppError } from '../../../shared/errors'

/** Limite de cada comando de cliente MCP (spec §11.1 / §15). */
export const CLI_TIMEOUT_MS = 15_000
/** Limite ao consultar o PATH do shell de login (spec §11.1). */
export const SHELL_TIMEOUT_MS = 3_000

export interface CliRunResult {
  stdout: string
  stderr: string
}

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number }
) => Promise<CliRunResult>

export interface CliDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  /** Injetável nos testes; o padrão usa `execFile` (nunca shell). */
  execFile?: ExecFileFn
  fileExists?: (path: string) => Promise<boolean>
}

export interface Cli {
  find(name: string): Promise<string | null>
  run(file: string, args: readonly string[]): Promise<CliRunResult>
}

/** Executa sem shell, com limite, anexando a saída ao erro para virar `CLIENT_CLI_FAILED`. */
export async function runCli(
  file: string,
  args: readonly string[],
  options: { execFile?: ExecFileFn; timeoutMs?: number } = {}
): Promise<CliRunResult> {
  const execFile = options.execFile ?? defaultExecFile
  try {
    return await execFile(file, [...args], { timeout: options.timeoutMs ?? CLI_TIMEOUT_MS })
  } catch (error) {
    throw cliFailure(error)
  }
}

/** Procura em PATH, no PATH do shell de login (POSIX) e nos caminhos conhecidos (spec §11.1). */
export function createCliFinder(deps: CliDeps): (name: string) => Promise<string | null> {
  const fileExists = deps.fileExists ?? defaultFileExists
  const shellPath = createShellPath(deps)
  return async (name) => {
    const dirs = [...pathDirs(deps.env.PATH, deps.platform), ...(await shellPath()), ...knownDirs(deps)]
    for (const dir of dirs) {
      const found = await findInDir(dir, name, deps.platform, fileExists)
      if (found !== null) return found
    }
    return null
  }
}

/** Localiza o executável e roda o comando; executável ausente vira `CLIENT_CLI_FAILED`. */
export async function runFound(
  cli: Cli,
  name: string,
  args: readonly string[]
): Promise<void> {
  const executable = await cli.find(name)
  if (executable === null) {
    throw new AppError('CLIENT_CLI_FAILED', `The ${name} executable was not found.`)
  }
  await cli.run(executable, args)
}

export function createCli(deps: CliDeps): Cli {
  const execFile = deps.execFile ?? defaultExecFile
  return {
    find: createCliFinder(deps),
    run: (file, args) => runCli(file, args, { execFile })
  }
}

export const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { timeout: options.timeout, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(new Error(error.message), { stdout, stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })

export async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function cliFailure(error: unknown): AppError {
  const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  const output = [record.stdout, record.stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .join('\n')
  return new AppError(
    'CLIENT_CLI_FAILED',
    output === '' ? String(record.message ?? error) : output
  )
}

function createShellPath(deps: CliDeps): () => Promise<string[]> {
  let cached: string[] | null = null
  return async () => {
    if (deps.platform === 'win32') return []
    cached ??= await readLoginPath(deps)
    return cached
  }
}

async function readLoginPath(deps: CliDeps): Promise<string[]> {
  const shell = deps.env.SHELL ?? '/bin/sh'
  const execFile = deps.execFile ?? defaultExecFile
  try {
    const { stdout } = await execFile(shell, ['-ilc', 'echo $PATH'], { timeout: SHELL_TIMEOUT_MS })
    return pathDirs(stdout.trim(), deps.platform)
  } catch {
    return []
  }
}

function pathDirs(value: string | undefined, platform: NodeJS.Platform): string[] {
  if (value === undefined || value === '') return []
  const delimiter = platform === 'win32' ? ';' : ':'
  return value
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '')
}

function knownDirs(deps: CliDeps): string[] {
  const join = joinFor(deps.platform)
  const dirs = [
    join(deps.home, '.local', 'bin'),
    join(deps.home, '.claude', 'local'),
    join(deps.home, '.npm-global', 'bin')
  ]
  if (deps.platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  if (deps.env.APPDATA) dirs.push(join(deps.env.APPDATA, 'npm'))
  if (deps.env.LOCALAPPDATA) dirs.push(join(deps.env.LOCALAPPDATA, 'Programs'))
  return dirs
}

/** `path.join` do SO simulado, para montar caminhos do Windows mesmo em testes no Linux. */
function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32'
    ? (...parts: string[]) => win32.join(...parts)
    : (...parts: string[]) => posix.join(...parts)
}

async function findInDir(
  dir: string,
  name: string,
  platform: NodeJS.Platform,
  fileExists: (path: string) => Promise<boolean>
): Promise<string | null> {
  const join = joinFor(platform)
  for (const candidate of candidates(name, platform)) {
    const full = join(dir, candidate)
    if (await fileExists(full)) return full
  }
  return null
}

function candidates(name: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name]
}
