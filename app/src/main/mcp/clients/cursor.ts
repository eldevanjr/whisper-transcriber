import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { commandOf, createJsonConnector, isDirectory, manualJson } from './json-connector'
import type { ConnectorDeps, McpClientConnector } from './registry'

/** Cursor (spec §11.2): `mcpServers` em `~/.cursor/mcp.json`; precisa reiniciar. */
export function createCursorConnector(deps: ConnectorDeps): McpClientConnector {
  const entry = (d: ConnectorDeps): Record<string, unknown> => ({ command: d.launcherPath, args: [] })
  return createJsonConnector(deps, {
    id: 'cursor',
    name: MCP_CLIENT_NAMES.cursor,
    needsRestart: true,
    allowComments: false,
    configFile: (d) => join(d.home, '.cursor', 'mcp.json'),
    present: (d) => isDirectory(join(d.home, '.cursor')),
    section: 'mcpServers',
    entry,
    isConnected: (value, d) => commandOf(value) === d.launcherPath,
    manualText: (d) => manualJson('mcpServers', entry(d))
  })
}
