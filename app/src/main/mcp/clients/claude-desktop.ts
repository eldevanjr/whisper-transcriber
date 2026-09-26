import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import {
  appDataDir,
  commandOf,
  createJsonConnector,
  isDirectory,
  manualJson
} from './json-connector'
import type { ConnectorDeps, McpClientConnector } from './registry'

const CONFIG_FILE = 'claude_desktop_config.json'

/** Claude Desktop (spec §11.2): `mcpServers` em `claude_desktop_config.json`; precisa reiniciar. */
export function createClaudeDesktopConnector(deps: ConnectorDeps): McpClientConnector {
  const entry = (d: ConnectorDeps): Record<string, unknown> => ({
    command: d.launcherPath,
    args: []
  })
  return createJsonConnector(deps, {
    id: 'claude-desktop',
    name: MCP_CLIENT_NAMES['claude-desktop'],
    needsRestart: true,
    allowComments: false,
    configFile: (d) => join(desktopDir(d), CONFIG_FILE),
    present: (d) => isDirectory(desktopDir(d)),
    section: 'mcpServers',
    entry,
    isConnected: (value, d) => commandOf(value) === d.launcherPath,
    manualText: (d) => manualJson('mcpServers', entry(d))
  })
}

function desktopDir(deps: ConnectorDeps): string {
  if (deps.platform === 'darwin') {
    return join(deps.home, 'Library', 'Application Support', 'Claude')
  }
  if (deps.platform === 'win32') return join(appDataDir(deps), 'Claude')
  return join(deps.home, '.config', 'Claude')
}
