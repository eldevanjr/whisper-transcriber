import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toAppError } from '../../../shared/errors'
import type { McpClientId } from '../../../shared/mcp'
import {
  CONFIG_KEY,
  isPlainObject,
  mergeJsonConfig,
  readJsonConfig,
  removeJsonConfig,
  type JsonObject
} from './json-config'
import type {
  ClientStateInfo,
  ClientStatusError,
  ConnectorDeps,
  McpClientConnector
} from './registry'

/** Aviso do cartão quando a config aponta para outro caminho (spec §11.1). */
export const STALE_CONFIG_MESSAGE = 'Old config points to a different path; connect again.'

export interface JsonConnectorSpec {
  id: McpClientId
  name: string
  needsRestart: boolean
  /** Clientes JSONC (OpenCode, VS Code) aceitam comentários; nós nunca os reescrevemos. */
  allowComments: boolean
  configFile: (deps: ConnectorDeps) => string
  present: (deps: ConnectorDeps) => Promise<boolean>
  section: string
  entry: (deps: ConnectorDeps) => JsonObject
  isConnected: (value: unknown, deps: ConnectorDeps) => boolean
  manualText: (deps: ConnectorDeps) => string
}

/**
 * Conector base para clientes cuja config é um JSON com uma seção de servidores. Lê e altera só a
 * nossa entrada, preserva o resto e a ordem, faz backup e recusa arquivos inválidos/comentados.
 */
export function createJsonConnector(
  deps: ConnectorDeps,
  spec: JsonConnectorSpec
): McpClientConnector {
  const status = async (): Promise<ClientStateInfo> => {
    if (!(await spec.present(deps))) return { state: 'missing' }
    let data: JsonObject | null
    try {
      data = await readJsonConfig(spec.configFile(deps), { allowComments: spec.allowComments })
    } catch (error) {
      return { state: 'found', error: toStatusError(error) }
    }
    const current = valueOf(data, spec.section)
    if (current === undefined) return { state: 'found' }
    return spec.isConnected(current, deps)
      ? { state: 'connected' }
      : { state: 'found', error: { message: STALE_CONFIG_MESSAGE } }
  }

  return {
    id: spec.id,
    name: spec.name,
    needsRestart: spec.needsRestart,
    status,
    detect: async () => (await status()).state,
    connect: async () => {
      await mergeJsonConfig(
        spec.configFile(deps),
        (data) => {
          sectionObject(data, spec.section)[CONFIG_KEY] = spec.entry(deps)
        },
        { allowComments: spec.allowComments }
      )
      return { restartNeeded: spec.needsRestart }
    },
    disconnect: async () => {
      await removeJsonConfig(
        spec.configFile(deps),
        (data) => {
          const section = data[spec.section]
          if (isPlainObject(section)) Reflect.deleteProperty(section, CONFIG_KEY)
        },
        { allowComments: spec.allowComments }
      )
    },
    manual: () => ({ kind: 'json', text: spec.manualText(deps) })
  }
}

/** Trecho JSON pronto para colar, com a seção e a nossa entrada (spec §11.2). */
export function manualJson(section: string, entry: JsonObject): string {
  return JSON.stringify({ [section]: { [CONFIG_KEY]: entry } }, null, 2)
}

/** `command` de uma entrada JSON, quando for texto. */
export function commandOf(value: unknown): string | null {
  return isPlainObject(value) && typeof value.command === 'string' ? value.command : null
}

/** `command` de uma entrada do OpenCode: lista em que o primeiro item é o executável. */
export function commandListOf(value: unknown): unknown[] | null {
  if (!isPlainObject(value) || !Array.isArray(value.command)) return null
  const list: unknown[] = value.command
  return list
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** `%APPDATA%` no Windows; se faltar, o local padrão do perfil do usuário. */
export function appDataDir(deps: ConnectorDeps): string {
  return deps.env.APPDATA ?? join(deps.home, 'AppData', 'Roaming')
}

function valueOf(data: JsonObject | null, section: string): unknown {
  if (data === null) return undefined
  const group = data[section]
  return isPlainObject(group) ? group[CONFIG_KEY] : undefined
}

function sectionObject(data: JsonObject, section: string): JsonObject {
  const group = data[section]
  if (isPlainObject(group)) return group
  const created: JsonObject = {}
  data[section] = created
  return created
}

export function toStatusError(error: unknown): ClientStatusError {
  const app = toAppError(error)
  return { code: app.code, message: app.message }
}
