import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { commandOf, createJsonConnector, isDirectory, manualJson } from './json-connector'
import type { ConnectorDeps, McpClientConnector } from './registry'

/** Windsurf (spec §11.2): `mcpServers` em `mcp_config.json`; precisa reiniciar. */
export function createWindsurfConnector(deps: ConnectorDeps): McpClientConnector {
  const entry = (d: ConnectorDeps): Record<string, unknown> => ({ command: d.launcherPath, args: [] })
  return createJsonConnector(deps, {
    id: 'windsurf',
    name: MCP_CLIENT_NAMES.windsurf,
    needsRestart: true,
    allowComments: false,
    configFile: (d) => join(d.home, '.codeium', 'windsurf', 'mcp_config.json'),
    present: (d) => isDirectory(join(d.home, '.codeium', 'windsurf')),
    section: 'mcpServers',
    entry,
    isConnected: (value, d) => commandOf(value) === d.launcherPath,
    manualText: (d) => manualJson('mcpServers', entry(d))
  })
}
