import { describe, expect, it } from 'vitest'
import { createClaudeCodeConnector } from '../../../../src/main/mcp/clients/claude-code'
import { LAUNCHER, makeDeps, recordingCli } from './helpers'

describe('claude-code', () => {
  it('id, nome e natureza (não precisa reiniciar)', () => {
    const connector = createClaudeCodeConnector(makeDeps())
    expect(connector.id).toBe('claude-code')
    expect(connector.name).toBe('Claude Code')
    expect(connector.needsRestart).toBe(false)
  })

  it('detect: missing quando o executável não existe', async () => {
    const connector = createClaudeCodeConnector(makeDeps({ cli: recordingCli(null) }))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: connected quando `claude mcp get` sai com 0', async () => {
    const cli = recordingCli('/bin/claude')
    const connector = createClaudeCodeConnector(makeDeps({ cli }))
    expect(await connector.detect()).toBe('connected')
    expect(cli.run).toHaveBeenCalledWith('/bin/claude', ['mcp', 'get', 'whisper-transcriber'])
  })

  it('detect: found quando `claude mcp get` falha', async () => {
    const cli = recordingCli('/bin/claude')
    cli.run.mockRejectedValueOnce(new Error('não configurado'))
    const connector = createClaudeCodeConnector(makeDeps({ cli }))
    expect(await connector.detect()).toBe('found')
  })

  it('connect: comando exato e restartNeeded false', async () => {
    const cli = recordingCli('/bin/claude')
    const connector = createClaudeCodeConnector(makeDeps({ cli }))
    expect(await connector.connect()).toEqual({ restartNeeded: false })
    expect(cli.run).toHaveBeenCalledWith('/bin/claude', [
      'mcp',
      'add',
      '--scope',
      'user',
      'whisper-transcriber',
      '--',
      LAUNCHER
    ])
  })

  it('connect: remove a entrada antiga antes de adicionar (substitui config de outro caminho)', async () => {
    const cli = recordingCli('/bin/claude')
    cli.run.mockRejectedValueOnce(new Error('No MCP server found'))
    const connector = createClaudeCodeConnector(makeDeps({ cli }))
    await connector.connect()
    expect(cli.run.mock.calls.map(([, args]) => args[1])).toEqual(['remove', 'add'])
  })

  it('connect: sem executável vira CLIENT_CLI_FAILED', async () => {
    const connector = createClaudeCodeConnector(makeDeps({ cli: recordingCli(null) }))
    await expect(connector.connect()).rejects.toMatchObject({ code: 'CLIENT_CLI_FAILED' })
  })

  it('disconnect: comando exato', async () => {
    const cli = recordingCli('/bin/claude')
    const connector = createClaudeCodeConnector(makeDeps({ cli }))
    await connector.disconnect()
    expect(cli.run).toHaveBeenCalledWith('/bin/claude', [
      'mcp',
      'remove',
      '--scope',
      'user',
      'whisper-transcriber'
    ])
  })

  it('disconnect: sem executável vira CLIENT_CLI_FAILED', async () => {
    const connector = createClaudeCodeConnector(makeDeps({ cli: recordingCli(null) }))
    await expect(connector.disconnect()).rejects.toMatchObject({ code: 'CLIENT_CLI_FAILED' })
  })

  it('manual: comando exato com o lançador entre aspas', () => {
    const connector = createClaudeCodeConnector(makeDeps())
    expect(connector.manual()).toEqual({
      kind: 'command',
      text: `claude mcp add --scope user whisper-transcriber -- "${LAUNCHER}"`
    })
  })
})
