import { join } from 'node:path'
import type { ModelFormat, ModelId } from '../shared/models'

export interface AppPaths {
  root: string
  settings: string
  settingsBackup: string
  models: string
  modelsGgml: string
  cuda: string
  history: string
  logs: string
  mcpDir: string
  mcpLauncher: string
  mcpBridgeInfo: string
  mcpBridgeSocket: string
  mcpActivity: string
  mcpSession: string
}

export function appPaths(userData: string, platform: NodeJS.Platform = process.platform): AppPaths {
  const mcpDir = join(userData, 'mcp')
  // Windows chama o lançador com .cmd; nos demais SO o script sh não tem extensão (spec §6).
  const launcher = platform === 'win32' ? 'whisper-transcriber-mcp.cmd' : 'whisper-transcriber-mcp'
  return {
    root: userData,
    settings: join(userData, 'settings.json'),
    settingsBackup: join(userData, 'settings.bak.json'),
    models: join(userData, 'models'),
    modelsGgml: join(userData, 'models-ggml'),
    cuda: join(userData, 'cuda'),
    history: join(userData, 'history'),
    logs: join(userData, 'logs'),
    mcpDir,
    mcpLauncher: join(mcpDir, launcher),
    mcpBridgeInfo: join(mcpDir, 'bridge.json'),
    mcpBridgeSocket: join(mcpDir, 'bridge.sock'),
    mcpActivity: join(mcpDir, 'activity.jsonl'),
    mcpSession: join(mcpDir, 'session')
  }
}

export function modelDir(paths: AppPaths, id: ModelId, format: ModelFormat = 'ct2'): string {
  return join(format === 'ggml' ? paths.modelsGgml : paths.models, id)
}
