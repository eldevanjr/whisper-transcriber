import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Device } from '../../shared/settings'

export interface WorkerCommandLine {
  command: string
  args: string[]
  cwd?: string
}

export function resolveWorkerCommand(input: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  platform: NodeJS.Platform
}): WorkerCommandLine {
  if (input.isPackaged) {
    const executable = input.platform === 'win32' ? 'transcriber-worker.exe' : 'transcriber-worker'
    return { command: join(input.resourcesPath, 'worker', executable), args: [] }
  }
  const workerDir = join(input.appPath, '..', 'worker')
  return {
    command: 'uv',
    args: ['run', '--project', workerDir, 'python', '-m', 'transcriber_worker'],
    cwd: workerDir
  }
}

export function cudaLibraryDirs(cudaDir: string): string[] {
  const nvidia = join(cudaDir, 'nvidia')
  if (!existsSync(nvidia)) return []
  return readdirSync(nvidia)
    .map((name) => join(nvidia, name, 'lib'))
    .filter((dir) => existsSync(dir))
    .sort()
}

export function workerEnv(
  base: NodeJS.ProcessEnv,
  options: { platform: NodeJS.Platform; device: Device; cudaDir: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
  // No Linux o loader só lê LD_LIBRARY_PATH na partida do processo (no Windows o worker usa o PATH).
  if (options.platform !== 'linux' || options.device !== 'cuda') return env
  const current = base.LD_LIBRARY_PATH
  env.LD_LIBRARY_PATH = [...cudaLibraryDirs(options.cudaDir), ...(current ? [current] : [])].join(
    ':'
  )
  return env
}
