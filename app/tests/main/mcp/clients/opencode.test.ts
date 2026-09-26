import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOpenCodeConnector } from '../../../../src/main/mcp/clients/opencode'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const file = (): string => join(root, '.config', 'opencode', 'opencode.json')
const entry = { type: 'local', command: [LAUNCHER], enabled: true }

describe('opencode', () => {
  it('id, nome e natureza (não precisa reiniciar)', () => {
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('opencode')
    expect(connector.name).toBe('OpenCode')
    expect(connector.needsRestart).toBe(false)
  })

  it('detect: missing sem pasta e sem executável', async () => {
    const connector = createOpenCodeConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found só com a pasta', async () => {
    await mkdir(dirname(file()), { recursive: true })
    const connector = createOpenCodeConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('found')
  })

  it('detect: found só com o executável', async () => {
    const connector = createOpenCodeConnector(
      makeDeps({ home: root, cli: recordingCli('/bin/opencode') })
    )
    expect(await connector.detect()).toBe('found')
  })

  it('connect grava type local, command em lista e enabled, com backup', async () => {
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(await connector.connect()).toEqual({ restartNeeded: false })
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      mcp: { 'whisper-transcriber': entry }
    })
    expect(await connector.detect()).toBe('connected')
  })

  it('detect: connected quando o command tem o lançador', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify({ mcp: { 'whisper-transcriber': entry } }), 'utf8')
    const connector = createOpenCodeConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('connected')
  })

  it('detect: avisa quando aponta para outro caminho', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcp: { 'whisper-transcriber': { type: 'local', command: ['/antigo'] } } }),
      'utf8'
    )
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('detect: found quando a entrada não é um objeto', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify({ mcp: { 'whisper-transcriber': 'x' } }), 'utf8')
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
  })

  it('detect: found quando command não é uma lista', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcp: { 'whisper-transcriber': { type: 'local', command: '/x' } } }),
      'utf8'
    )
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('connect: arquivo JSONC com comentários não é tocado', async () => {
    await mkdir(dirname(file()), { recursive: true })
    const text = '// config do usuário\n{ "mcp": {} }\n'
    await writeFile(file(), text, 'utf8')
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    await expect(connector.connect()).rejects.toMatchObject({ code: 'CONFIG_HAS_COMMENTS' })
    expect(await readFile(file(), 'utf8')).toBe(text)
  })

  it('disconnect remove só a nossa chave', async () => {
    await mkdir(dirname(file()), { recursive: true })
    await writeFile(
      file(),
      JSON.stringify({ mcp: { outro: { type: 'local' }, 'whisper-transcriber': entry } }),
      'utf8'
    )
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    await connector.disconnect()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      mcp: { outro: { type: 'local' } }
    })
  })

  it('manual: trecho JSON exato', () => {
    const connector = createOpenCodeConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({
      kind: 'json',
      text: JSON.stringify({ mcp: { 'whisper-transcriber': entry } }, null, 2)
    })
  })
})
