import { chmod, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launcherStatus, launcherTarget, writeLauncher } from '../../../src/main/mcp/launcher'
import { appPaths } from '../../../src/main/paths'
import { makeTempDir } from '../../helpers/tmp'

const EXEC = '/opt/Whisper Transcriber/whisper-transcriber'

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('launcherTarget', () => {
  const base = {
    execPath: EXEC,
    env: {},
    isPackaged: true,
    appPath: '/repo/app'
  }

  it('empacotado usa process.execPath (deb, NSIS e macOS)', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(launcherTarget({ ...base, platform })).toEqual({ command: EXEC, args: [] })
    }
  })

  it('AppImage usa $APPIMAGE em vez do ponto de montagem temporário', () => {
    expect(
      launcherTarget({
        ...base,
        platform: 'linux',
        env: { APPIMAGE: '/home/u/Whisper Transcriber.AppImage' }
      })
    ).toEqual({ command: '/home/u/Whisper Transcriber.AppImage', args: [] })
  })

  it('AppImage sem APPIMAGE cai no executável atual', () => {
    expect(launcherTarget({ ...base, platform: 'linux', env: { APPIMAGE: '' } })).toEqual({
      command: EXEC,
      args: []
    })
    expect(launcherTarget({ ...base, platform: 'linux', env: {} }).command).toBe(EXEC)
  })

  it('fora do Linux ignora APPIMAGE', () => {
    expect(launcherTarget({ ...base, platform: 'win32', env: { APPIMAGE: '/x' } }).command).toBe(
      EXEC
    )
  })

  it('desenvolvimento usa o Electron do projeto + o diretório do app', () => {
    const appPath = '/repo/app'
    expect(launcherTarget({ ...base, isPackaged: false, platform: 'linux', appPath })).toEqual({
      command: join(appPath, 'node_modules', 'electron', 'dist', 'electron'),
      args: [appPath]
    })
    // O argumento tem que ser o diretório de package.json; `out/main/index.js` faria o Electron
    // usar outro app/userData (spec §6: o processo MCP lê os dados do app de verdade).
    expect(launcherTarget({ ...base, isPackaged: false, platform: 'linux', appPath }).args).toEqual([
      appPath
    ])
    expect(
      launcherTarget({ ...base, isPackaged: false, platform: 'win32', appPath }).command
    ).toBe(join(appPath, 'node_modules', 'electron', 'dist', 'electron.exe'))
    expect(
      launcherTarget({ ...base, isPackaged: false, platform: 'darwin', appPath }).command
    ).toBe(
      join(
        appPath,
        'node_modules',
        'electron',
        'dist',
        'Electron.app',
        'Contents',
        'MacOS',
        'Electron'
      )
    )
  })
})

describe('launcherStatus', () => {
  it('começa sem erro, para a tela não piscar "Com problema" antes da 1ª gravação', () => {
    expect(launcherStatus()).toEqual({ ok: true, error: null })
  })
})

describe('writeLauncher', () => {
  it('POSIX: script sh exato e modo 0755', async () => {
    const paths = appPaths(root, 'linux')
    await writeLauncher(paths, { command: EXEC, args: [] }, 'linux')
    expect(await readFile(paths.mcpLauncher, 'utf8')).toBe(
      `#!/bin/sh\nexec "${EXEC}" --mcp "$@"\n`
    )
    if (process.platform !== 'win32') {
      expect((await stat(paths.mcpLauncher)).mode & 0o777).toBe(0o755)
    }
    expect(launcherStatus()).toEqual({ ok: true, error: null })
  })

  it('POSIX: aspas em torno de cada argumento com espaço', async () => {
    const paths = appPaths(root, 'linux')
    await writeLauncher(
      paths,
      { command: '/a b/electron', args: ['/c d/out/main/index.js'] },
      'linux'
    )
    expect(await readFile(paths.mcpLauncher, 'utf8')).toBe(
      '#!/bin/sh\nexec "/a b/electron" "/c d/out/main/index.js" --mcp "$@"\n'
    )
  })

  it('POSIX: escapa aspas, barra invertida e cifrão do caminho', async () => {
    const paths = appPaths(root, 'linux')
    await writeLauncher(paths, { command: '/home/u/a"b\\c$d', args: [] }, 'linux')
    expect(await readFile(paths.mcpLauncher, 'utf8')).toBe(
      '#!/bin/sh\nexec "/home/u/a\\"b\\\\c\\$d" --mcp "$@"\n'
    )
  })

  it('Windows: script .cmd exato', async () => {
    const paths = appPaths(root, 'win32')
    await writeLauncher(
      paths,
      { command: 'C:\\Program Files\\Whisper Transcriber\\Whisper Transcriber.exe', args: [] },
      'win32'
    )
    expect(await readFile(paths.mcpLauncher, 'utf8')).toBe(
      '@"C:\\Program Files\\Whisper Transcriber\\Whisper Transcriber.exe" --mcp %*\r\n'
    )
  })

  it('Windows: escapa aspas no caminho', async () => {
    const paths = appPaths(root, 'win32')
    await writeLauncher(paths, { command: 'C:\\a"b\\app.exe', args: ['C:\\c d\\x.js'] }, 'win32')
    expect(await readFile(paths.mcpLauncher, 'utf8')).toBe(
      '@"C:\\a""b\\app.exe" "C:\\c d\\x.js" --mcp %*\r\n'
    )
  })

  it('não regrava quando o conteúdo é igual (mtime preservado)', async () => {
    const paths = appPaths(root, 'linux')
    const target = { command: EXEC, args: [] }
    await writeLauncher(paths, target, 'linux')
    const past = new Date(1_000_000_000_000)
    await utimes(paths.mcpLauncher, past, past)
    await writeLauncher(paths, target, 'linux')
    expect((await stat(paths.mcpLauncher)).mtimeMs).toBe(1_000_000_000_000)
  })

  it('Windows: conteúdo igual também não regrava', async () => {
    const paths = appPaths(root, 'win32')
    const target = { command: 'C:\\app.exe', args: [] }
    await writeLauncher(paths, target, 'win32')
    const past = new Date(1_000_000_000_000)
    await utimes(paths.mcpLauncher, past, past)
    await writeLauncher(paths, target, 'win32')
    expect((await stat(paths.mcpLauncher)).mtimeMs).toBe(1_000_000_000_000)
  })

  it.skipIf(process.platform === 'win32')(
    'restaura o modo 0755 quando o conteúdo é igual (sem mexer no mtime)',
    async () => {
      const paths = appPaths(root, 'linux')
      const target = { command: EXEC, args: [] }
      await writeLauncher(paths, target, 'linux')
      const past = new Date(1_000_000_000_000)
      await utimes(paths.mcpLauncher, past, past)
      await chmod(paths.mcpLauncher, 0o644)
      await writeLauncher(paths, target, 'linux')
      const stats = await stat(paths.mcpLauncher)
      expect(stats.mode & 0o777).toBe(0o755)
      expect(stats.mtimeMs).toBe(1_000_000_000_000)
      expect(launcherStatus()).toEqual({ ok: true, error: null })
    }
  )

  it('regrava quando o conteúdo muda', async () => {
    const paths = appPaths(root, 'linux')
    await writeLauncher(paths, { command: '/antigo', args: [] }, 'linux')
    await writeLauncher(paths, { command: '/novo', args: [] }, 'linux')
    expect(await readFile(paths.mcpLauncher, 'utf8')).toContain('/novo')
  })

  it.skipIf(process.platform === 'win32')('cria a pasta mcp com modo 0700', async () => {
    const paths = appPaths(root, 'linux')
    await writeLauncher(paths, { command: '/x', args: [] }, 'linux')
    expect((await stat(paths.mcpDir)).mode & 0o777).toBe(0o700)
  })

  it('falha na gravação fica no status e é propagada', async () => {
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const paths = appPaths(root, 'linux')
    const broken = {
      ...paths,
      mcpDir: join(blocker, 'mcp'),
      mcpLauncher: join(blocker, 'mcp', 'launcher')
    }
    await expect(writeLauncher(broken, { command: '/x', args: [] }, 'linux')).rejects.toThrow()
    expect(launcherStatus().ok).toBe(false)
    expect(launcherStatus().error).toBeTruthy()
  })
})
