import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { commandOf, createJsonConnector, isDirectory, manualJson } from './json-connector'
import type { ConnectorDeps, McpClientConnector } from './registry'

/** Gemini CLI (spec §11.2): `mcpServers` em `~/.gemini/settings.json`; precisa reiniciar. */
export function createGeminiCliConnector(deps: ConnectorDeps): McpClientConnector {
  const entry = (d: ConnectorDeps): Record<string, unknown> => ({ command: d.launcherPath })
  return createJsonConnector(deps, {
    id: 'gemini-cli',
    name: MCP_CLIENT_NAMES['gemini-cli'],
    needsRestart: true,
    allowComments: false,
    configFile: (d) => join(d.home, '.gemini', 'settings.json'),
    present: async (d) =>
      (await isDirectory(join(d.home, '.gemini'))) || (await d.cli.find('gemini')) !== null,
    section: 'mcpServers',
    entry,
    isConnected: (value, d) => commandOf(value) === d.launcherPath,
    manualText: (d) => manualJson('mcpServers', entry(d))
  })
}
