import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appPaths, modelDir } from '../../src/main/paths'

describe('paths', () => {
  it('monta a árvore da pasta de dados', () => {
    const paths = appPaths('/u')
    expect(paths).toEqual({
      root: '/u',
      settings: join('/u', 'settings.json'),
      settingsBackup: join('/u', 'settings.bak.json'),
      models: join('/u', 'models'),
      modelsGgml: join('/u', 'models-ggml'),
      cuda: join('/u', 'cuda'),
      history: join('/u', 'history'),
      logs: join('/u', 'logs'),
      mcpDir: join('/u', 'mcp'),
      mcpLauncher: join('/u', 'mcp', 'whisper-transcriber-mcp'),
      mcpBridgeInfo: join('/u', 'mcp', 'bridge.json'),
      mcpBridgeSocket: join('/u', 'mcp', 'bridge.sock'),
      mcpActivity: join('/u', 'mcp', 'activity.jsonl'),
      mcpSession: join('/u', 'mcp', 'session'),
      state: join('/u', 'state.json')
    })
    expect(modelDir(paths, 'medium')).toBe(join('/u', 'models', 'medium'))
    expect(modelDir(paths, 'medium', 'ggml')).toBe(join('/u', 'models-ggml', 'medium'))
  })

  it('usa o launcher com .cmd só no Windows', () => {
    expect(appPaths('/u', 'win32').mcpLauncher).toBe(
      join('/u', 'mcp', 'whisper-transcriber-mcp.cmd')
    )
    expect(appPaths('/u', 'linux').mcpLauncher).toBe(join('/u', 'mcp', 'whisper-transcriber-mcp'))
    expect(appPaths('/u', 'darwin').mcpLauncher).toBe(join('/u', 'mcp', 'whisper-transcriber-mcp'))
    expect(appPaths('/u', 'win32').mcpDir).toBe(join('/u', 'mcp'))
  })
})
