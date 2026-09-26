import { spawn as spawnProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '../../shared/errors'
import type { LauncherTarget } from './launcher'

/** O app tem até 60 s para responder à ponte (spec §8 / §15). */
export const APP_START_TIMEOUT_MS = 60_000
/** Tentativas de `ping` a cada 500 ms enquanto o app abre (spec §8). */
export const APP_POLL_MS = 500

export interface AppConnection {
  connect(): Promise<{ ready: boolean }>
}

export type SpawnFn = (command: string, args: string[]) => unknown

export interface EnsureAppRunningInput {
  launcherTarget: LauncherTarget | null
  client: AppConnection
  spawn?: SpawnFn
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const attempts = new WeakMap<object, Promise<void>>()

/**
 * Abre o app quando fechado e espera a ponte (spec §8): spawn destacado sem `--mcp`, `ping` a
 * cada 500 ms por até 60 s. Chamadas simultâneas do mesmo processo compartilham a tentativa.
 */
export function ensureAppRunning(input: EnsureAppRunningInput): Promise<void> {
  const existing = attempts.get(input.client)
  if (existing) return existing
  const attempt = run(input).finally(() => {
    attempts.delete(input.client)
  })
  attempts.set(input.client, attempt)
  return attempt
}

/** Amarra o alvo e o cliente num abridor reutilizável; usado pela ponte do processo MCP. */
export function createAppRunner(input: EnsureAppRunningInput): () => Promise<void> {
  return () => ensureAppRunning(input)
}

/** Sobe o executável do app destacado, sem janela de console e sem `--mcp` (spec §8). */
export function defaultSpawn(command: string, args: string[]): { unref: () => void } {
  const child = spawnProcess(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

async function run(input: EnsureAppRunningInput): Promise<void> {
  if (await reachable(input)) return
  if (!input.launcherTarget) {
    throw new AppError('WORKER_UNAVAILABLE', 'Whisper Transcriber is not running')
  }
  const spawn = input.spawn ?? defaultSpawn
  spawn(input.launcherTarget.command, input.launcherTarget.args)
  await waitUntilReady(input)
}

/** `true` = ponte respondeu pronta; `SETUP_INCOMPLETE` sobe; `false` = ainda não respondeu. */
async function reachable(input: EnsureAppRunningInput): Promise<boolean> {
  try {
    const { ready } = await input.client.connect()
    if (!ready) {
      throw new AppError('SETUP_INCOMPLETE', 'Finish Whisper Transcriber setup and try again.')
    }
    return true
  } catch (error) {
    if (error instanceof AppError && error.code === 'SETUP_INCOMPLETE') throw error
    return false
  }
}

async function waitUntilReady(input: EnsureAppRunningInput): Promise<void> {
  const sleep = input.sleep ?? delay
  const now = input.now ?? Date.now
  const deadline = now() + (input.timeoutMs ?? APP_START_TIMEOUT_MS)
  const pollMs = input.pollMs ?? APP_POLL_MS
  while (now() < deadline) {
    await sleep(pollMs)
    if (await reachable(input)) return
  }
  throw new AppError('APP_START_TIMEOUT', 'Whisper Transcriber did not start in time.')
}
