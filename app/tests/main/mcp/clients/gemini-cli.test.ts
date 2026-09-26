import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGeminiCliConnector } from '../../../../src/main/mcp/clients/gemini-cli'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const file = (): string => join(root, '.gemini', 'settings.json')
const entry = { command: LAUNCHER }

describe('gemini-cli', () => {
  it('id, nome e natureza (precisa reiniciar)', () => {
    const connector = createGeminiCliConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('gemini-cli')
    expect(connector.name).toBe('Gemini CLI')
    expect(connector.needsRestart).toBe(true)
  })

  it('detect: missing sem pasta e sem executável', async () => {
    const connector = createGeminiCliConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found só com o executável', async () => {
    const connector = createGeminiCliConnector(
      makeDeps({ home: root, cli: recordingCli('/bin/gemini') })
    )
    expect(await connector.detect()).toBe('found')
  })

  it('connect grava mcpServers com command e pede reinício', async () => {
    const connector = createGeminiCliConnector(makeDeps({ home: root }))
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
    const connector = createGeminiCliConnector(makeDeps({ home: root }))
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
    const connector = createGeminiCliConnector(makeDeps({ home: root }))
    await connector.disconnect()
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      mcpServers: { outro: { command: '/x' } }
    })
  })

  it('manual: trecho JSON exato', () => {
    const connector = createGeminiCliConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({
      kind: 'json',
      text: JSON.stringify({ mcpServers: { 'whisper-transcriber': entry } }, null, 2)
    })
  })
})
