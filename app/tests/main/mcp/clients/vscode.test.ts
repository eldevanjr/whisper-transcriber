import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVscodeConnector } from '../../../../src/main/mcp/clients/vscode'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const userFile = (): string => join(root, '.config', 'Code', 'User', 'mcp.json')

describe('vscode', () => {
  it('id, nome e natureza (não precisa reiniciar)', () => {
    const connector = createVscodeConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('vscode')
    expect(connector.name).toBe('VS Code')
    expect(connector.needsRestart).toBe(false)
  })

  it('detect: missing sem o executável', async () => {
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found com o executável e sem a entrada', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(userFile(), JSON.stringify({ servers: { outro: { command: '/x' } } }), 'utf8')
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('found')
  })

  it('detect: connected quando o mcp.json do usuário tem a entrada', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(
      userFile(),
      JSON.stringify({ servers: { 'whisper-transcriber': { command: LAUNCHER } } }),
      'utf8'
    )
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('connected')
  })

  it('connect: comando exato com o JSON do servidor', async () => {
    const cli = recordingCli('/bin/code')
    const connector = createVscodeConnector(makeDeps({ home: root, cli }))
    expect(await connector.connect()).toEqual({ restartNeeded: false })
    expect(cli.run).toHaveBeenCalledWith('/bin/code', [
      '--add-mcp',
      JSON.stringify({ name: 'whisper-transcriber', command: LAUNCHER })
    ])
  })

  it('connect: sem executável vira CLIENT_CLI_FAILED', async () => {
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    await expect(connector.connect()).rejects.toMatchObject({ code: 'CLIENT_CLI_FAILED' })
  })

  it('disconnect remove só a nossa chave', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(
      userFile(),
      JSON.stringify({
        servers: { outro: { command: '/x' }, 'whisper-transcriber': { command: LAUNCHER } }
      }),
      'utf8'
    )
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    await connector.disconnect()
    expect(JSON.parse(await readFile(userFile(), 'utf8'))).toEqual({
      servers: { outro: { command: '/x' } }
    })
    expect(await readFile(`${userFile()}.bak`, 'utf8')).toBeTruthy()
  })

  it('disconnect: JSONC com comentários não é tocado', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    const text = '// mcp do usuário\n{ "servers": {} }\n'
    await writeFile(userFile(), text, 'utf8')
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    await expect(connector.disconnect()).rejects.toMatchObject({ code: 'CONFIG_HAS_COMMENTS' })
    expect(await readFile(userFile(), 'utf8')).toBe(text)
  })

  it('detect: found com o executável e sem o arquivo', async () => {
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('found')
  })

  it('detect: aceita a entrada em mcpServers (config antiga)', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(
      userFile(),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': { command: LAUNCHER } } }),
      'utf8'
    )
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('connected')
  })

  it('detect: found quando a seção não é objeto', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(userFile(), JSON.stringify({ servers: 5 }), 'utf8')
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('found')
  })

  it('detect: avisa quando aponta para outro caminho', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    await writeFile(
      userFile(),
      JSON.stringify({ servers: { 'whisper-transcriber': { command: '/antigo' } } }),
      'utf8'
    )
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('propaga config inválida e comentários no status', async () => {
    await mkdir(dirname(userFile()), { recursive: true })
    const connector = createVscodeConnector(makeDeps({ home: root, cli: recordingCli('/bin/code') }))
    await writeFile(userFile(), '{ quebrado', 'utf8')
    expect((await connector.status()).error?.code).toBe('CONFIG_INVALID')
    await writeFile(userFile(), '// nota\n{ "servers": {} }\n', 'utf8')
    expect((await connector.status()).error?.code).toBe('CONFIG_HAS_COMMENTS')
  })

  it('usa o mcp.json do perfil no macOS', async () => {
    const macFile = join(root, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    await mkdir(dirname(macFile), { recursive: true })
    await writeFile(
      macFile,
      JSON.stringify({ servers: { 'whisper-transcriber': { command: LAUNCHER } } }),
      'utf8'
    )
    const connector = createVscodeConnector(
      makeDeps({ home: root, platform: 'darwin', cli: recordingCli('/bin/code') })
    )
    expect(await connector.detect()).toBe('connected')
  })

  it('usa %APPDATA% no Windows e cai no padrão quando falta', async () => {
    const roaming = join(root, 'Roaming')
    const winFile = join(roaming, 'Code', 'User', 'mcp.json')
    await mkdir(dirname(winFile), { recursive: true })
    await writeFile(
      winFile,
      JSON.stringify({ servers: { 'whisper-transcriber': { command: LAUNCHER } } }),
      'utf8'
    )
    const connector = createVscodeConnector(
      makeDeps({
        home: root,
        platform: 'win32',
        env: { APPDATA: roaming },
        cli: recordingCli('/bin/code')
      })
    )
    expect(await connector.detect()).toBe('connected')

    const fallback = createVscodeConnector(
      makeDeps({ home: root, platform: 'win32', env: {}, cli: recordingCli('/bin/code') })
    )
    expect(await fallback.detect()).toBe('found')
  })

  it('manual: comando exato com o lançador', () => {
    const connector = createVscodeConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({
      kind: 'command',
      text: `code --add-mcp '${JSON.stringify({ name: 'whisper-transcriber', command: LAUNCHER })}'`
    })
  })
})
