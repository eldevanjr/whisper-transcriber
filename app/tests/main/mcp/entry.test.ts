import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closedAppBridge,
  isMcpMode,
  readSettingsFrom,
  runMcp,
  type McpDeps
} from '../../../src/main/mcp/entry'
import { appPaths } from '../../../src/main/paths'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

interface FakeApp {
  calls: string[]
  locale: string
  dock?: { hide(): void }
  disableHardwareAcceleration(): void
  setPath(name: string, path: string): void
  getVersion(): string
  getLocale(): string
  whenReady(): Promise<void>
  quit(): void
  requestSingleInstanceLock(): boolean
  createWindow(): void
}

function makeApp(locale = 'pt-BR'): FakeApp {
  const calls: string[] = []
  const app: FakeApp = {
    calls,
    locale,
    disableHardwareAcceleration: () => {
      calls.push('disableHardwareAcceleration')
    },
    setPath: (name, path) => {
      calls.push(`setPath:${name}=${path}`)
    },
    getVersion: () => '9.9.9',
    getLocale: () => {
      calls.push('getLocale')
      return app.locale
    },
    whenReady: () => {
      calls.push('whenReady')
      return Promise.resolve()
    },
    quit: () => {
      calls.push('quit')
    },
    requestSingleInstanceLock: () => {
      calls.push('requestSingleInstanceLock')
      return true
    },
    createWindow: () => {
      calls.push('createWindow')
    }
  }
  return app
}

interface FakeLogger {
  logs: string[]
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  transports: {
    file: { resolvePathFn: () => string; maxSize: number }
    console: { level: string | false }
  }
}

function makeLogger(): FakeLogger {
  const logs: string[] = []
  return {
    logs,
    info: (message) => {
      logs.push(message)
    },
    warn: (message) => {
      logs.push(message)
    },
    error: (message) => {
      logs.push(message)
    },
    transports: {
      file: { resolvePathFn: () => '', maxSize: 0 },
      console: { level: 'silly' }
    }
  }
}

interface Harness {
  root: string
  app: FakeApp
  logger: FakeLogger
  deps: McpDeps
  stdin: PassThrough
  stdout: PassThrough
}

async function harness(options: { dock?: boolean; locale?: string } = {}): Promise<Harness> {
  const root = await makeTempDir()
  const app = makeApp(options.locale)
  if (options.dock) {
    app.dock = {
      hide: () => {
        app.calls.push('dock.hide')
      }
    }
  }
  const logger = makeLogger()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const deps = {
    app: app as unknown as McpDeps['app'],
    stdin,
    stdout,
    paths: appPaths(root),
    logger: logger as unknown as McpDeps['logger']
  }
  return { root, app, logger, deps, stdin, stdout }
}

let roots: string[] = []

async function trackedHarness(options: { dock?: boolean; locale?: string } = {}): Promise<Harness> {
  const context = await harness(options)
  roots.push(context.root)
  return context
}

beforeEach(() => {
  roots = []
})

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('isMcpMode', () => {
  it('is true only when --mcp is present in argv', () => {
    expect(isMcpMode(['electron', 'out/main/index.js', '--mcp'])).toBe(true)
    expect(isMcpMode(['electron', 'out/main/index.js'])).toBe(false)
    expect(isMcpMode([])).toBe(false)
  })
})

describe('runMcp lifecycle', () => {
  it('diverts without requesting the single-instance lock and without a window', async () => {
    const context = await trackedHarness()
    await runMcp(context.deps)
    expect(context.app.calls).not.toContain('requestSingleInstanceLock')
    expect(context.app.calls).not.toContain('createWindow')
  })

  it('disables hardware acceleration and sets sessionData before ready', async () => {
    const context = await trackedHarness()
    await runMcp(context.deps)
    expect(context.app.calls).toContain('disableHardwareAcceleration')
    const session = `setPath:sessionData=${context.deps.paths.mcpSession}`
    expect(context.app.calls.indexOf(session)).toBeGreaterThanOrEqual(0)
    expect(context.app.calls.indexOf(session)).toBeLessThan(context.app.calls.indexOf('whenReady'))
  })

  it('hides the dock on macOS', async () => {
    const context = await trackedHarness({ dock: true })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      await runMcp(context.deps)
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
    expect(context.app.calls).toContain('dock.hide')
  })

  it('logs only to logs/mcp.log and turns the console transport off', async () => {
    const context = await trackedHarness()
    await runMcp(context.deps)
    expect(context.logger.transports.file.resolvePathFn()).toBe(
      join(context.deps.paths.logs, 'mcp.log')
    )
    expect(context.logger.transports.file.maxSize).toBe(1024 * 1024)
    expect(context.logger.transports.console.level).toBe(false)
    expect(context.logger.logs.some((line) => line.includes('[mcp]'))).toBe(true)
  })

  it('keeps stdout free of anything but the transport', async () => {
    const context = await trackedHarness()
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runMcp(context.deps)
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('quits the app when stdin ends', async () => {
    const context = await trackedHarness()
    await runMcp(context.deps)
    context.stdin.emit('end')
    expect(context.app.calls).toContain('quit')
  })
})

describe('speaker labels language', () => {
  it('follows the system locale when uiLanguage is not set', async () => {
    const context = await trackedHarness({ locale: 'es-419' })
    await runMcp(context.deps)
    expect(context.app.calls).toContain('getLocale')
  })

  it('uses uiLanguage from settings without asking the system locale', async () => {
    const context = await trackedHarness()
    const stored = { ...DEFAULT_SETTINGS, uiLanguage: 'en' }
    await writeFile(context.deps.paths.settings, JSON.stringify(stored), 'utf8')
    await runMcp(context.deps)
    expect(context.app.calls).not.toContain('getLocale')
  })
})

describe('readSettingsFrom', () => {
  it('reads settings.json from disk', async () => {
    const root = await makeTempDir()
    roots.push(root)
    const path = join(root, 'settings.json')
    const stored = { ...DEFAULT_SETTINGS, mcp: { enabled: true, allowTranscribe: false } }
    await writeFile(path, JSON.stringify(stored), 'utf8')
    expect(await readSettingsFrom(path)()).toMatchObject({
      mcp: { enabled: true, allowTranscribe: false }
    })
  })

  it('falls back to the defaults when the file is missing or invalid', async () => {
    const root = await makeTempDir()
    roots.push(root)
    expect(await readSettingsFrom(join(root, 'missing.json'))()).toEqual(DEFAULT_SETTINGS)

    const broken = join(root, 'broken.json')
    await writeFile(broken, 'not json', 'utf8')
    expect(await readSettingsFrom(broken)()).toEqual(DEFAULT_SETTINGS)

    const wrong = join(root, 'wrong.json')
    await writeFile(wrong, JSON.stringify({ version: 1 }), 'utf8')
    expect(await readSettingsFrom(wrong)()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('closedAppBridge', () => {
  it('answers as if the app were closed', async () => {
    expect(await closedAppBridge.activity()).toEqual({
      appRunning: false,
      current: null,
      pending: [],
      live: null
    })
    expect(await closedAppBridge.status('01930000-0000-7000-8000-000000000000')).toBeNull()
    await expect(closedAppBridge.transcribe('/tmp/a.mp4', 'codex', false)).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE'
    })
  })
})

describe('settings written by the MCP process', () => {
  it('does not touch settings.json while reading', async () => {
    const context = await trackedHarness()
    const before = await readFile(context.deps.paths.settings, 'utf8').catch(() => null)
    await runMcp(context.deps)
    const after = await readFile(context.deps.paths.settings, 'utf8').catch(() => null)
    expect(after).toBe(before)
  })
})
