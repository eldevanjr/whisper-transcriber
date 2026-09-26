import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { App } from 'electron'
import type electronLog from 'electron-log/main'
import { AppError } from '../../shared/errors'
import type { ActivitySnapshot } from '../../shared/mcp'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../../shared/settings'
import type { SpeakerLabels } from '../../shared/format'
import { readJson } from '../fs-utils'
import { HistoryStore } from '../history/store'
import type { AppPaths } from '../paths'
import { ActivityLog } from './activity'
import { TranscriptLibrary } from './library'
import { createMcpServer, type BridgePort } from './server'

/** Só o que o processo MCP usa do `app` do Electron (spec §5.2). */
export type McpApp = Pick<
  App,
  'disableHardwareAcceleration' | 'dock' | 'setPath' | 'getVersion' | 'whenReady' | 'quit'
>

/** O electron-log de produção; os testes passam um dublê (console desligado, só arquivo). */
export type McpLogger = Pick<typeof electronLog, 'info' | 'warn' | 'error' | 'transports'>

export interface McpDeps {
  app: McpApp
  stdin: Readable
  stdout: Writable
  paths: AppPaths
  logger: McpLogger
}

/** Tamanho máximo de `logs/mcp.log` (spec §12). */
const LOG_MAX_BYTES = 1024 * 1024

const SPEAKER_LABELS: SpeakerLabels = { voce: 'Você', outros: 'Outros' }

/** Retrato de app fechado; a ponte real é a Task 7. */
const CLOSED_APP: ActivitySnapshot = {
  appRunning: false,
  current: null,
  pending: [],
  live: null
}

/**
 * Ponte provisória do processo MCP: sem app aberto, a leitura vem só do disco e qualquer ação
 * que precise do motor responde que o app está fechado (a Task 7 troca pelo `BridgeClient` real).
 */
export const closedAppBridge: BridgePort = {
  activity: () => Promise.resolve(CLOSED_APP),
  status: () => Promise.resolve(null),
  transcribe: () =>
    Promise.reject(new AppError('WORKER_UNAVAILABLE', 'Whisper Transcriber is not running'))
}

/** `--mcp` desvia o processo antes do `requestSingleInstanceLock` (spec §5.2). */
export function isMcpMode(argv: readonly string[]): boolean {
  return argv.includes('--mcp')
}

/** Lê `settings.json` a cada chamada, sem escrever nada no disco (spec §5.2/§11). */
export function readSettingsFrom(settingsPath: string): () => Promise<Settings> {
  return async () => {
    try {
      const parsed = SettingsSchema.safeParse(await readJson(settingsPath))
      return parsed.success ? parsed.data : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }
}

/**
 * Prepara o Electron para o processo MCP e liga o servidor ao stdio (spec §5.2): sem janela,
 * sem lock, perfil (`sessionData`) próprio e log só em `logs/mcp.log`.
 */
export async function runMcp(deps: McpDeps): Promise<void> {
  const { app, stdin, stdout, paths, logger } = deps
  app.disableHardwareAcceleration()
  if (process.platform === 'darwin') app.dock?.hide()
  await mkdir(paths.mcpSession, { recursive: true, mode: 0o700 })
  app.setPath('sessionData', paths.mcpSession)
  logger.transports.file.resolvePathFn = () => join(paths.logs, 'mcp.log')
  logger.transports.file.maxSize = LOG_MAX_BYTES
  logger.transports.console.level = false
  logger.info(`[mcp] iniciando (versão ${app.getVersion()})`)
  await app.whenReady()
  const server = createMcpServer({
    library: new TranscriptLibrary(new HistoryStore(paths.history), SPEAKER_LABELS),
    activity: new ActivityLog(paths.mcpActivity),
    readSettings: readSettingsFrom(paths.settings),
    bridge: closedAppBridge,
    version: app.getVersion()
  })
  await server.connect(new StdioServerTransport(stdin, stdout))
  stdin.on('end', () => {
    app.quit()
  })
}
