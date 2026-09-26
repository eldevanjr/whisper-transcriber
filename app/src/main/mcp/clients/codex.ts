import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { runFound } from './cli'
import type { ClientStateInfo, ConnectorDeps, McpClientConnector } from './registry'

const SECTION = /^\s*\[mcp_servers\.whisper-transcriber\]\s*$/m
const ADD_ARGS = ['mcp', 'add', 'whisper-transcriber', '--'] as const
const REMOVE_ARGS = ['mcp', 'remove', 'whisper-transcriber'] as const

/**
 * Codex (spec §11.2): CLI `codex`, conectado quando `~/.codex/config.toml` tem a seção
 * `[mcp_servers.whisper-transcriber]`. Novas sessões já pegam a config.
 */
export function createCodexConnector(deps: ConnectorDeps): McpClientConnector {
  const status = async (): Promise<ClientStateInfo> => {
    if ((await deps.cli.find('codex')) === null) return { state: 'missing' }
    return (await hasSection(configFile(deps))) ? { state: 'connected' } : { state: 'found' }
  }

  return {
    id: 'codex',
    name: MCP_CLIENT_NAMES.codex,
    needsRestart: false,
    status,
    detect: async () => (await status()).state,
    connect: async () => {
      await runFound(deps.cli, 'codex', [...ADD_ARGS, deps.launcherPath])
      return { restartNeeded: false }
    },
    disconnect: () => runFound(deps.cli, 'codex', REMOVE_ARGS),
    manual: () => ({ kind: 'toml', text: codexToml(deps.launcherPath) })
  }
}

function configFile(deps: ConnectorDeps): string {
  return join(deps.home, '.codex', 'config.toml')
}

async function hasSection(file: string): Promise<boolean> {
  try {
    return SECTION.test(await readFile(file, 'utf8'))
  } catch {
    return false
  }
}

/** TOML entre aspas básicas: escape de barra invertida e aspas (caminhos do Windows). */
function codexToml(launcher: string): string {
  const escaped = launcher.replace(/["\\]/g, '\\$&')
  return `[mcp_servers.whisper-transcriber]\ncommand = "${escaped}"`
}
