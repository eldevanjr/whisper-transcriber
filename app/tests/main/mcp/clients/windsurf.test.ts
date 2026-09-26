import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWindsurfConnector } from '../../../../src/main/mcp/clients/windsurf'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const file = (): string => join(root, '.codeium', 'windsurf', 'mcp_config.json')
const entry = { command: LAUNCHER, args: [] }

describe('windsurf', () => {
  it('id, nome e natureza (precisa reiniciar)', () => {
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('windsurf')
    expect(connector.name).toBe('Windsurf')
    expect(connector.needsRestart).toBe(true)
  })

  it('detect: missing sem a pasta', async () => {
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found com a pasta e sem a entrada', async () => {
    await mkdir(dirname(file()), { recursive: true })
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
  })

  it('connect grava mcpServers e pede reinício', async () => {
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(await connector.connect()).toEqual({ restartNeeded: true })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      mcpServers: { 'whisper-transcriber': entry }
    })
    expect(await connector.detect()).toBe('connected')
  })

  it('detect: avisa quando aponta para outro caminho', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': { command: '/antigo' } } }),
      'utf8'
    )
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('disconnect remove só a nossa chave', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcpServers: { outro: { command: '/x' }, 'whisper-transcriber': entry } }),
      'utf8'
    )
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    await connector.disconnect()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      mcpServers: { outro: { command: '/x' } }
    })
  })

  it('manual: trecho JSON exato', () => {
    const connector = createWindsurfConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({
      kind: 'json',
      text: JSON.stringify({ mcpServers: { 'whisper-transcriber': entry } }, null, 2)
    })
  })
})
