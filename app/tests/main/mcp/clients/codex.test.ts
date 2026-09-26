import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCodexConnector } from '../../../../src/main/mcp/clients/codex'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeCodexConfig(content: string): Promise<void> {
  await mkdir(join(root, '.codex'), { recursive: true })
  await writeFile(join(root, '.codex', 'config.toml'), content, 'utf8')
}

function tomlFor(launcher: string): string {
  const escaped = launcher.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[mcp_servers.whisper-transcriber]\ncommand = "${escaped}"`
}

describe('codex', () => {
  it('id, nome e natureza (não precisa reiniciar)', () => {
    const connector = createCodexConnector(makeDeps({ home: root }))
    expect(connector.id).toBe('codex')
    expect(connector.name).toBe('Codex')
    expect(connector.needsRestart).toBe(false)
  })

  it('detect: missing quando o executável não existe', async () => {
    await writeCodexConfig('[mcp_servers.whisper-transcriber]\ncommand = "/x"')
    const connector = createCodexConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found com o executável mas sem a seção', async () => {
    await writeCodexConfig('[outra]\ncommand = "/x"')
    const connector = createCodexConnector(
      makeDeps({ home: root, cli: recordingCli('/bin/codex') })
    )
    expect(await connector.detect()).toBe('found')
  })

  it('detect: found quando ainda não há config.toml', async () => {
    const connector = createCodexConnector(
      makeDeps({ home: root, cli: recordingCli('/bin/codex') })
    )
    expect(await connector.detect()).toBe('found')
  })

  it('detect: connected quando o config.toml tem a seção', async () => {
    await writeCodexConfig(tomlFor(LAUNCHER))
    const connector = createCodexConnector(
      makeDeps({ home: root, cli: recordingCli('/bin/codex') })
    )
    expect(await connector.detect()).toBe('connected')
  })

  it('connect: comando exato e restartNeeded false', async () => {
    const cli = recordingCli('/bin/codex')
    const connector = createCodexConnector(makeDeps({ home: root, cli }))
    expect(await connector.connect()).toEqual({ restartNeeded: false })
    expect(cli.run).toHaveBeenCalledWith('/bin/codex', [
      'mcp',
      'add',
      'whisper-transcriber',
      '--',
      LAUNCHER
    ])
  })

  it('connect: sem executável vira CLIENT_CLI_FAILED', async () => {
    const connector = createCodexConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    await expect(connector.connect()).rejects.toMatchObject({ code: 'CLIENT_CLI_FAILED' })
  })

  it('disconnect: comando exato', async () => {
    const cli = recordingCli('/bin/codex')
    const connector = createCodexConnector(makeDeps({ home: root, cli }))
    await connector.disconnect()
    expect(cli.run).toHaveBeenCalledWith('/bin/codex', ['mcp', 'remove', 'whisper-transcriber'])
  })

  it('disconnect: sem executável vira CLIENT_CLI_FAILED', async () => {
    const connector = createCodexConnector(makeDeps({ home: root, cli: recordingCli(null) }))
    await expect(connector.disconnect()).rejects.toMatchObject({ code: 'CLIENT_CLI_FAILED' })
  })

  it('manual: TOML exato', () => {
    const connector = createCodexConnector(makeDeps({ home: root }))
    expect(connector.manual()).toEqual({ kind: 'toml', text: tomlFor(LAUNCHER) })
  })

  it('manual: escapa barras invertidas no Windows', () => {
    const launcher =
      'C:\\Users\\u\\AppData\\Roaming\\Whisper Transcriber\\mcp\\whisper-transcriber-mcp.cmd'
    const connector = createCodexConnector(
      makeDeps({ home: root, platform: 'win32', launcherPath: launcher })
    )
    expect(connector.manual().text).toBe(tomlFor(launcher))
    expect(connector.manual().text).toContain('\\\\')
  })
})
