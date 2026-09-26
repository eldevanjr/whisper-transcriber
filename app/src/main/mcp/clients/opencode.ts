import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { commandListOf, createJsonConnector, isDirectory, manualJson } from './json-connector'
import type { ConnectorDeps, McpClientConnector } from './registry'

/**
 * OpenCode (spec §11.2): `mcp.whisper-transcriber` com `type: "local"`, `command` em lista e
 * `enabled: true`, em `~/.config/opencode/opencode.json`. Aceita JSONC; não precisa reiniciar.
 */
export function createOpenCodeConnector(deps: ConnectorDeps): McpClientConnector {
  const entry = (d: ConnectorDeps): Record<string, unknown> => ({
    type: 'local',
    command: [d.launcherPath],
    enabled: true
  })
  return createJsonConnector(deps, {
    id: 'opencode',
    name: MCP_CLIENT_NAMES.opencode,
    needsRestart: false,
    allowComments: true,
    configFile: (d) => join(d.home, '.config', 'opencode', 'opencode.json'),
    present: async (d) =>
      (await isDirectory(join(d.home, '.config', 'opencode'))) ||
      (await d.cli.find('opencode')) !== null,
    section: 'mcp',
    entry,
    isConnected: (value, d) => commandListOf(value)?.[0] === d.launcherPath,
    manualText: (d) => manualJson('mcp', entry(d))
  })
}
