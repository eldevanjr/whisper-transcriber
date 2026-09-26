import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClaudeDesktopConnector } from '../../../../src/main/mcp/clients/claude-desktop'
import { makeTempDir } from '../../../helpers/tmp'
import { LAUNCHER, makeDeps } from './helpers'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Platform = NodeJS.Platform

function configPath(platform: Platform): string {
  if (platform === 'darwin') {
    return join(root, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (platform === 'win32') {
    return join(root, 'Roaming', 'Claude', 'claude_desktop_config.json')
  }
  return join(root, '.config', 'Claude', 'claude_desktop_config.json')
}

function depsFor(platform: Platform) {
  return makeDeps({
    platform,
    home: root,
    env: platform === 'win32' ? { APPDATA: join(root, 'Roaming') } : {}
  })
}

function expectedManual(launcher: string): string {
  return JSON.stringify(
    { mcpServers: { 'whisper-transcriber': { command: launcher, args: [] } } },
    null,
    2
  )
}

describe.each<Platform>(['linux', 'darwin', 'win32'])('claude-desktop (%s)', (platform) => {
  it('detect: missing quando a pasta não existe', async () => {
    const connector = createClaudeDesktopConnector(depsFor(platform))
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found com a pasta mas sem a nossa entrada', async () => {
    await mkdir(dirname(configPath(platform)), { recursive: true })
    const connector = createClaudeDesktopConnector(depsFor(platform))
    expect(await connector.detect()).toBe('found')
  })

  it('connect grava a entrada no arquivo e pede reinício', async () => {
    const connector = createClaudeDesktopConnector(depsFor(platform))
    expect(await connector.connect()).toEqual({ restartNeeded: true })
    const raw = await readFile(configPath(platform), 'utf8')
    expect(JSON.parse(raw)).toEqual({
      mcpServers: { 'whisper-transcriber': { command: LAUNCHER, args: [] } }
    })
    expect(await connector.detect()).toBe('connected')

    await connector.disconnect()
    expect(await connector.detect()).toBe('found')
    expect(JSON.parse(await readFile(configPath(platform), 'utf8'))).toEqual({ mcpServers: {} })
  })
})

describe('claude-desktop (extra)', () => {
  it('avisa quando a entrada aponta para outro caminho', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(
      configPath('linux'),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': { command: '/antigo' } } }),
      'utf8'
    )
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    expect(await connector.detect()).toBe('found')
    const info = await connector.status()
    expect(info.error?.message).toMatch(/connect again/i)
  })

  it('propaga erro de config inválida no status', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(configPath('linux'), '{ quebrado', 'utf8')
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.code).toBe('CONFIG_INVALID')
  })

  it('manual: trecho JSON com o lançador', () => {
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    expect(connector.manual()).toEqual({ kind: 'json', text: expectedManual(LAUNCHER) })
  })

  it('usa o local padrão do Windows quando %APPDATA% falta', async () => {
    const connector = createClaudeDesktopConnector(
      makeDeps({ platform: 'win32', home: root, env: {} })
    )
    expect(await connector.detect()).toBe('missing')
  })

  it('detect: found quando a seção não é um objeto', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(configPath('linux'), JSON.stringify({ mcpServers: 5 }), 'utf8')
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    expect(await connector.detect()).toBe('found')
  })

  it('avisa quando a entrada não tem um command de texto', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(
      configPath('linux'),
      JSON.stringify({ mcpServers: { 'whisper-transcriber': 'x' } }),
      'utf8'
    )
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    expect(await connector.detect()).toBe('found')
    expect((await connector.status()).error?.message).toMatch(/connect again/i)
  })

  it('connect preserva servidores existentes na seção', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(
      configPath('linux'),
      JSON.stringify({ mcpServers: { outro: { command: '/x' } } }),
      'utf8'
    )
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    await connector.connect()
    expect(JSON.parse(await readFile(configPath('linux'), 'utf8'))).toEqual({
      mcpServers: {
        outro: { command: '/x' },
        'whisper-transcriber': { command: LAUNCHER, args: [] }
      }
    })
  })

  it('no Windows grava o caminho .cmd com barras invertidas escapadas', async () => {
    const launcher =
      'C:\\Users\\u\\AppData\\Roaming\\Whisper Transcriber\\mcp\\whisper-transcriber-mcp.cmd'
    const connector = createClaudeDesktopConnector(
      makeDeps({
        platform: 'win32',
        home: root,
        env: { APPDATA: join(root, 'Roaming') },
        launcherPath: launcher
      })
    )
    await connector.connect()
    const raw = await readFile(configPath('win32'), 'utf8')
    expect(raw).toContain('\\\\')
    expect(JSON.parse(raw)).toEqual({
      mcpServers: { 'whisper-transcriber': { command: launcher, args: [] } }
    })
  })

  it('disconnect ignora seção que não é objeto', async () => {
    await mkdir(dirname(configPath('linux')), { recursive: true })
    await writeFile(configPath('linux'), JSON.stringify({ mcpServers: 5 }), 'utf8')
    const connector = createClaudeDesktopConnector(depsFor('linux'))
    await connector.disconnect()
    expect(JSON.parse(await readFile(configPath('linux'), 'utf8'))).toEqual({ mcpServers: 5 })
  })
})
