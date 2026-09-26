import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { runFound } from './cli'
import type { ClientStateInfo, ConnectorDeps, McpClientConnector } from './registry'

const GET_ARGS = ['mcp', 'get', 'whisper-transcriber'] as const
const ADD_ARGS = ['mcp', 'add', '--scope', 'user', 'whisper-transcriber', '--'] as const
const REMOVE_ARGS = ['mcp', 'remove', '--scope', 'user', 'whisper-transcriber'] as const

/**
 * Claude Code (spec §11.2): CLI `claude`, conectado quando `claude mcp get` sai com 0.
 * Novas sessões já pegam a config; não precisa reiniciar.
 */
export function createClaudeCodeConnector(deps: ConnectorDeps): McpClientConnector {
  const status = async (): Promise<ClientStateInfo> => {
    const claude = await deps.cli.find('claude')
    if (claude === null) return { state: 'missing' }
    try {
      await deps.cli.run(claude, GET_ARGS)
      return { state: 'connected' }
    } catch {
      return { state: 'found' }
    }
  }

  return {
    id: 'claude-code',
    name: MCP_CLIENT_NAMES['claude-code'],
    needsRestart: false,
    status,
    detect: async () => (await status()).state,
    connect: async () => {
      // `mcp add` recusa um nome que já existe: uma entrada antiga (outro caminho) seria
      // impossível de atualizar pelo botão. Remove antes; a falha (não existia) é esperada.
      await runFound(deps.cli, 'claude', REMOVE_ARGS).catch(() => undefined)
      await runFound(deps.cli, 'claude', [...ADD_ARGS, deps.launcherPath])
      return { restartNeeded: false }
    },
    disconnect: () => runFound(deps.cli, 'claude', REMOVE_ARGS),
    manual: () => ({
      kind: 'command',
      text: `claude mcp add --scope user whisper-transcriber -- "${deps.launcherPath}"`
    })
  }
}
