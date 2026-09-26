import type { ClientState, ClientStatus, ClientStatusError, McpClientId } from '../../../shared/mcp'
import { createClaudeCodeConnector } from './claude-code'
import { createClaudeDesktopConnector } from './claude-desktop'
import type { Cli } from './cli'
import { createCodexConnector } from './codex'
import { createCursorConnector } from './cursor'
import { createGeminiCliConnector } from './gemini-cli'
import { createOpenCodeConnector } from './opencode'
import { createVscodeConnector } from './vscode'
import { createWindsurfConnector } from './windsurf'

export type { ClientState, ClientStatus, ClientStatusError }

export interface ClientStateInfo {
  state: ClientState
  error?: ClientStatusError
}

export interface ManualConfig {
  kind: 'command' | 'json' | 'toml'
  text: string
}

export interface ConnectResult {
  restartNeeded: boolean
}

/**
 * Conector de um cliente MCP. `needsRestart` diz se o cliente precisa ser reiniciado depois de
 * conectar (spec §11.2); `status()` é a versão rica de `detect()` usada por `listClients`.
 */
export interface McpClientConnector {
  readonly id: McpClientId
  readonly name: string
  readonly needsRestart: boolean
  status(): Promise<ClientStateInfo>
  detect(): Promise<ClientState>
  connect(): Promise<ConnectResult>
  disconnect(): Promise<void>
  manual(): ManualConfig
}

export interface ConnectorDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  launcherPath: string
  cli: Cli
}

export interface ListClientsDeps extends ConnectorDeps {
  activity: { lastUseByClient(): Promise<Map<string, string>> }
}

/** Conectores na ordem da tela (spec §11.2): Claude Code, Claude Desktop, Codex, OpenCode… */
export function createConnectors(deps: ConnectorDeps): McpClientConnector[] {
  return [
    createClaudeCodeConnector(deps),
    createClaudeDesktopConnector(deps),
    createCodexConnector(deps),
    createOpenCodeConnector(deps),
    createCursorConnector(deps),
    createVscodeConnector(deps),
    createGeminiCliConnector(deps),
    createWindsurfConnector(deps)
  ]
}

/** Retrato de cada cliente para a tela: estado, último uso e erro (spec §10.2). */
export async function listClients(deps: ListClientsDeps): Promise<ClientStatus[]> {
  const lastUse = await deps.activity.lastUseByClient()
  return Promise.all(
    createConnectors(deps).map(async (connector) => {
      const info = await connector.status()
      const status: ClientStatus = {
        id: connector.id,
        name: connector.name,
        state: info.state,
        lastUsedAt: lastUse.get(connector.id) ?? null,
        restartNeeded: connector.needsRestart && info.state === 'connected'
      }
      if (info.error !== undefined) status.error = info.error
      return status
    })
  )
}
