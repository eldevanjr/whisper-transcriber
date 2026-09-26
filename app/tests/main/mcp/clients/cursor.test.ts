import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCursorConnector } from '../../../../src/main/mcp/clients/cursor'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const file = (): string => join(root, '.cursor', 'mcp.json')
const entry = { command: LAUNCHER, args: [] }

describe('cursor', () => {
  it('id, nome e natureza (precisa reiniciar)', () => {
    const connector = createCursorConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('cursor')
    expect(connector.name).toBe('Cursor')
    expect(connector.needsRestart).toBe(true)
  })

  it('detect: missing sem a pasta', async () => {
    const connector = createCursorConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found com a pasta e sem a entrada', async () => {
    await mkdir(dirname(file()), { recursive: true })
    const connector = createCursorConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
  })

  it('connect grava mcpServers e pede reinício', async () => {
    const connector = createCursorConnector(makeDeps({ home: root }))
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
    const connector = createCursorConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('disconnect mantém mcpServers vazio quando era o único', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': entry } }),
      'utf8'
    )
    const connector = createCursorConnector(makeDeps({ home: root }))
    await connector.disconnect()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ mcpServers: {} })
  })

  it('manual: trecho JSON exato', () => {
    const connector = createCursorConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({
      kind: 'json',
      text: JSON.stringify({ mcpServers: { 'whisper-transcriber': entry } }, null, 2)
    })
  })
})
