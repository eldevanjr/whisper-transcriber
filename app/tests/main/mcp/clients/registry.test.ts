import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConnectors, listClients } from '../../../../src/main/mcp/clients/registry'
import { MCP_CLIENT_IDS, MCP_CLIENT_NAMES } from '../../../../src/shared/mcp'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const desktopFile = (): string =>
  join(root, '.config', 'Claude', 'claude_desktop_config.json')

function listDeps(lastUse: Map<string, string> = new Map<string, string>()) {
  return {
    ...makeDeps({ home: root, cli: recordingCli(null) }),
    activity: { lastUseByClient: async () => lastUse }
  }
}

describe('createConnectors', () => {
  it('cria os 8 clientes na ordem da especificação', () => {
    const connectors = createConnectors(makeDeps({ home: root }))
    expect(connectors.map((connector) => connector.id)).toEqual([...MCP_CLIENT_IDS])
    expect(connectors.map((connector) => connector.name)).toEqual(
      MCP_CLIENT_IDS.map((id) => MCP_CLIENT_NAMES[id])
    )
  })
})

describe('listClients', () => {
  it('devolve todos ausentes, sem uso e sem reinício', async () => {
    const statuses = await listClients(listDeps())
    expect(statuses).toHaveLength(MCP_CLIENT_IDS.length)
    expect(statuses.every((status) => status.state === 'missing')).toBe(true)
    expect(statuses.every((status) => status.lastUsedAt === null)).toBe(true)
    expect(statuses.every((status) => !status.restartNeeded)).toBe(true)
    expect(statuses.every((status) => status.error === undefined)).toBe(true)
  })

  it('marca conectado, reinício e último uso do Claude Desktop', async () => {
    await mkdir(dirname(desktopFile()), { recursive: true })
    await writeFile(
      desktopFile(),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': { command: LAUNCHER, args: [] } } }),
      'utf8'
    )
    const used = '2026-09-26T12:00:00.000Z'
    const statuses = await listClients(listDeps(new Map([['claude-desktop', used]])))
    const desktop = statuses.find((status) => status.id === 'claude-desktop')
    expect(desktop).toEqual({
      id: 'claude-desktop',
      name: 'Claude Desktop',
      state: 'connected',
      lastUsedAt: used,
      restartNeeded: true
    })
  })

  it('inclui o erro do conector quando a config é inválida', async () => {
    await mkdir(dirname(desktopFile()), { recursive: true })
    await writeFile(desktopFile(), '{ quebrado', 'utf8')
    const statuses = await listClients(listDeps())
    const desktop = statuses.find((status) => status.id === 'claude-desktop')
    expect(desktop?.state).toBe('found')
    expect(desktop?.error?.code).toBe('CONFIG_INVALID')
  })
})
