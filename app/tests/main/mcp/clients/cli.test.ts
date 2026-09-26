import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  createCli,
  createCliFinder,
  defaultExecFile,
  defaultFileExists,
  runCli,
  type ExecFileFn
} from '../../../../src/main/mcp/clients/cli'
import { makeTempDir } from '../../../helpers/tmp'

type Predicate = (path: string) => Promise<boolean>

function existsAmong(paths: string[]): Predicate {
  return async (path) => paths.includes(path)
}

describe('createCliFinder', () => {
  it('acha no PATH do processo', async () => {
    const find = createCliFinder({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/usr/bin:/opt/x' },
      fileExists: existsAmong(['/opt/x/claude'])
    })
    expect(await find('claude')).toBe('/opt/x/claude')
  })

  it('acha no PATH do shell de login quando não está no PATH atual', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({
      stdout: '/shell/bin:/outro\n',
      stderr: ''
    }))
    const find = createCliFinder({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      execFile,
      fileExists: existsAmong(['/shell/bin/codex'])
    })
    expect(await find('codex')).toBe('/shell/bin/codex')
    expect(execFile).toHaveBeenCalledWith('/bin/zsh', ['-ilc', 'echo $PATH'], {
      timeout: SHELL_TIMEOUT_MS
    })
  })

  it('acha só nos caminhos conhecidos como último recurso', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '', stderr: '' }))
    const find = createCliFinder({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      execFile,
      fileExists: existsAmong([join('/home/u', '.local', 'bin', 'claude')])
    })
    expect(await find('claude')).toBe(join('/home/u', '.local', 'bin', 'claude'))
  })

  it('devolve null quando não encontra em lugar nenhum', async () => {
    const find = createCliFinder({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/usr/bin' },
      fileExists: async () => false
    })
    expect(await find('claude')).toBeNull()
  })

  it('não usa o shell de login no Windows e procura extensões .exe/.cmd', async () => {
    const execFile = vi.fn<ExecFileFn>()
    const find = createCliFinder({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: 'C:\\npm', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      execFile,
      fileExists: existsAmong(['C:\\npm\\codex.cmd'])
    })
    expect(await find('codex')).toBe('C:\\npm\\codex.cmd')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('inclui %APPDATA%\\npm e %LOCALAPPDATA%\\Programs no Windows', async () => {
    const find = createCliFinder({
      platform: 'win32',
      home: 'C:\\Users\\u',
      env: { PATH: '', APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' },
      fileExists: existsAmong([win32.join('C:\\Local', 'Programs', 'gemini.cmd')])
    })
    expect(await find('gemini')).toBe(win32.join('C:\\Local', 'Programs', 'gemini.cmd'))
  })

  it('cacheia o PATH do shell entre buscas', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '/shell/bin', stderr: '' }))
    const find = createCliFinder({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '', SHELL: '/bin/bash' },
      execFile,
      fileExists: existsAmong(['/shell/bin/a'])
    })
    expect(await find('a')).toBe('/shell/bin/a')
    expect(await find('b')).toBeNull()
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('segue procurando quando o shell de login falha', async () => {
    const find = createCliFinder({
      platform: 'darwin',
      home: '/Users/u',
      env: { PATH: '', SHELL: '/bin/zsh' },
      execFile: async () => {
        throw new Error('sem shell')
      },
      fileExists: existsAmong([join('/Users/u', '.npm-global', 'bin', 'codex')])
    })
    expect(await find('codex')).toBe(join('/Users/u', '.npm-global', 'bin', 'codex'))
  })
})

describe('runCli', () => {
  it('devolve stdout e stderr no sucesso', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: 'saida', stderr: 'aviso' }))
    expect(await runCli('/bin/x', ['a'], { execFile })).toEqual({ stdout: 'saida', stderr: 'aviso' })
    expect(execFile).toHaveBeenCalledWith('/bin/x', ['a'], { timeout: CLI_TIMEOUT_MS })
  })

  it('passa argumentos com espaços como itens separados, sem shell', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '', stderr: '' }))
    await runCli('/bin/x', ['mcp', 'add', 'a b'], { execFile })
    expect(execFile).toHaveBeenCalledWith('/bin/x', ['mcp', 'add', 'a b'], {
      timeout: CLI_TIMEOUT_MS
    })
  })

  it('falha vira CLIENT_CLI_FAILED com a saída dos dois fluxos', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'parcial', stderr: 'erro' })
    })
    await expect(runCli('/bin/x', [], { execFile })).rejects.toMatchObject({
      code: 'CLIENT_CLI_FAILED',
      message: 'parcial\nerro'
    })
  })

  it('erro sem saída usa a mensagem original', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw new Error('estourou o tempo')
    })
    await expect(runCli('/bin/x', [], { execFile })).rejects.toMatchObject({
      code: 'CLIENT_CLI_FAILED',
      message: 'estourou o tempo'
    })
  })

  it('respeita o tempo limite informado', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: '', stderr: '' }))
    await runCli('/bin/x', [], { execFile, timeoutMs: 10 })
    expect(execFile).toHaveBeenCalledWith('/bin/x', [], { timeout: 10 })
  })

  it('usa o executor padrão quando não recebe um', async () => {
    const result = await runCli(process.execPath, ['-e', 'process.stdout.write("d")'])
    expect(result.stdout).toBe('d')
  })

  it('erro sem mensagem usa o valor original', async () => {
    await expect(runCli('/bin/x', [], { execFile: () => Promise.reject({}) })).rejects.toMatchObject(
      { code: 'CLIENT_CLI_FAILED', message: '[object Object]' }
    )
  })
})

describe('createCli', () => {
  it('junta o localizador e o executor', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => ({ stdout: 'ok', stderr: '' }))
    const cli = createCli({
      platform: 'linux',
      home: '/home/u',
      env: { PATH: '/b' },
      execFile,
      fileExists: existsAmong(['/b/codex'])
    })
    expect(await cli.find('codex')).toBe('/b/codex')
    expect(await cli.run('/b/codex', ['mcp'])).toEqual({ stdout: 'ok', stderr: '' })
  })
})

describe('defaultExecFile / defaultFileExists', () => {
  let root: string

  beforeEach(async () => {
    root = await makeTempDir()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('roda um processo de verdade sem shell', async () => {
    const result = await defaultExecFile(process.execPath, ['-e', 'process.stdout.write("oi")'], {
      timeout: 5000
    })
    expect(result.stdout).toBe('oi')
  })

  it('rejeita com stdout/stderr anexados em erro real', async () => {
    await expect(
      defaultExecFile(process.execPath, ['-e', 'process.exit(3)'], { timeout: 5000 })
    ).rejects.toMatchObject({ stderr: expect.any(String) as string })
  })

  it('reconhece arquivo existente e ausente', async () => {
    const path = join(root, 'arquivo')
    await writeFile(path, 'x', 'utf8')
    expect(await defaultFileExists(path)).toBe(true)
    expect(await defaultFileExists(join(root, 'nao-existe'))).toBe(false)
    await mkdir(join(root, 'dir'), { recursive: true })
    expect(await defaultFileExists(join(root, 'dir'))).toBe(false)
  })

  it('createCli usa o localizador e o executor padrão quando não recebe dublês', async () => {
    const dir = join(root, 'bin')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'x'), '#!/bin/sh\n', 'utf8')
    const cli = createCli({ platform: 'linux', home: root, env: { PATH: dir } })
    expect(await cli.find('x')).toBe(join(dir, 'x'))
    const result = await cli.run(process.execPath, ['-e', 'process.stdout.write("z")'])
    expect(result.stdout).toBe('z')
  })
})
