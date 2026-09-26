import { join } from 'node:path'
import { MCP_CLIENT_NAMES } from '../../../shared/mcp'
import { runFound } from './cli'
import {
  CONFIG_KEY,
  isPlainObject,
  readJsonConfig,
  removeJsonConfig,
  type JsonObject
} from './json-config'
import { appDataDir, commandOf, toStatusError, STALE_CONFIG_MESSAGE } from './json-connector'
import type { ClientStateInfo, ConnectorDeps, McpClientConnector } from './registry'

/** VS Code usa `servers` no `mcp.json`; aceitamos `mcpServers` de configs antigas. */
const SECTIONS = ['servers', 'mcpServers'] as const

/**
 * VS Code (spec §11.2): CLI `code --add-mcp`; desconectar remove a chave do `mcp.json` do perfil
 * do usuário (JSONC; com comentários vira instrução manual). Não precisa reiniciar.
 */
export function createVscodeConnector(deps: ConnectorDeps): McpClientConnector {
  const status = async (): Promise<ClientStateInfo> => {
    if ((await deps.cli.find('code')) === null) return { state: 'missing' }
    let data: JsonObject | null
    try {
      data = await readJsonConfig(userFile(deps), { allowComments: true })
    } catch (error) {
      return { state: 'found', error: toStatusError(error) }
    }
    const value = entryValue(data)
    if (value === undefined) return { state: 'found' }
    return commandOf(value) === deps.launcherPath
      ? { state: 'connected' }
      : { state: 'found', error: { message: STALE_CONFIG_MESSAGE } }
  }

  return {
    id: 'vscode',
    name: MCP_CLIENT_NAMES.vscode,
    needsRestart: false,
    status,
    detect: async () => (await status()).state,
    connect: async () => {
      await runFound(deps.cli, 'code', ['--add-mcp', addMcpJson(deps)])
      return { restartNeeded: false }
    },
    disconnect: async () => {
      await removeJsonConfig(
        userFile(deps),
        (data) => {
          for (const section of SECTIONS) {
            const group = data[section]
            if (isPlainObject(group)) Reflect.deleteProperty(group, CONFIG_KEY)
          }
        },
        { allowComments: true }
      )
    },
    manual: () => ({ kind: 'command', text: `code --add-mcp '${addMcpJson(deps)}'` })
  }
}

function addMcpJson(deps: ConnectorDeps): string {
  return JSON.stringify({ name: CONFIG_KEY, command: deps.launcherPath })
}

function entryValue(data: JsonObject | null): unknown {
  if (data === null) return undefined
  for (const section of SECTIONS) {
    const group = data[section]
    if (isPlainObject(group) && group[CONFIG_KEY] !== undefined) return group[CONFIG_KEY]
  }
  return undefined
}

function userFile(deps: ConnectorDeps): string {
  const tail = ['Code', 'User', 'mcp.json']
  if (deps.platform === 'darwin') return join(deps.home, 'Library', 'Application Support', ...tail)
  if (deps.platform === 'win32') return join(appDataDir(deps), ...tail)
  return join(deps.home, '.config', ...tail)
}
