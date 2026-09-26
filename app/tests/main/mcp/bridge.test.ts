import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityTracker } from '../../../src/main/mcp/activity-tracker'
import {
  AUTH_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  bridgeAddress,
  ensureSocketDir,
  removeSocket,
  startBridgeServer,
  type BridgeQueue
} from '../../../src/main/mcp/bridge-server'
import {
  BridgeClient,
  createLiveBridge,
  type BridgeClientLike
} from '../../../src/main/mcp/bridge-client'
import { appPaths, type AppPaths } from '../../../src/main/paths'
import { AppError } from '../../../src/shared/errors'
import type { EnqueueResult } from '../../../src/shared/events'
import type { HistoryMeta } from '../../../src/shared/history'
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

function meta(overrides: Partial<HistoryMeta> = {}): HistoryMeta {
  return {
    id: randomUUID(),
    fileName: 'aula.mp4',
    sourcePath: '/v/aula.mp4',
    mediaKind: 'video',
    createdAt: '2026-09-23T10:00:00.000Z',
    status: 'queued',
    model: 'small',
    language: 'pt',
    languageDetected: null,
    duration: null,
    error: null,
    kind: 'file',
    ...overrides
  }
}

/** Conexão de teste: lê respostas JSON por linha. */
class Conn {
  private buffer = ''
  private readonly lines: string[] = []
  private readonly readers: ((line: string) => void)[] = []
  readonly closed: Promise<void>

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('data', (chunk: string) => {
      this.push(chunk)
    })
    this.closed = new Promise((resolve) =>
      socket.on('close', () => {
        resolve()
      })
    )
  }

  static open(address: string): Promise<Conn> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(address)
      socket.once('connect', () => {
        resolve(new Conn(socket))
      })
      socket.once('error', (error) => {
        reject(error)
      })
    })
  }

  send(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`)
  }

  raw(text: string): void {
    this.socket.write(text)
  }

  next<T = Record<string, unknown>>(): Promise<T> {
    const line =
      this.lines.length > 0
        ? Promise.resolve(this.lines.shift()!)
        : new Promise<string>((resolve) => this.readers.push(resolve))
    return line.then((value) => JSON.parse(value) as T)
  }

  end(): void {
    this.socket.destroy()
  }

  private push(chunk: string): void {
    this.buffer += chunk
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const reader = this.readers.shift()
      if (reader) reader(line)
      else this.lines.push(line)
    }
  }
}

interface ResponseShape {
  data?: Record<string, unknown> & { id?: string }
  error?: { code: string; message: string; detail?: string }
}

interface Harness {
  root: string
  paths: AppPaths
  token: string
  tracker: ActivityTracker
  enqueued: { paths: string[]; options?: { requestedBy?: string } }[]
  server: { address: string; close(): Promise<void> }
}

async function harness(
  options: {
    settings?: Partial<Settings>
    reject?: boolean
    authTimeoutMs?: number
    tracker?: ActivityTracker
    queue?: BridgeQueue
    processing?: boolean
    staleSocket?: boolean
  } = {}
): Promise<Harness> {
  const root = await makeTempDir()
  const paths = appPaths(root)
  if (options.staleSocket) {
    await mkdir(paths.mcpDir, { recursive: true })
    await writeFile(paths.mcpBridgeSocket, 'stale')
  }
  const tracker = options.tracker ?? new ActivityTracker()
  const enqueued: Harness['enqueued'] = []
  const queue: BridgeQueue = options.queue ?? {
    enqueue: async (targets, enqueueOptions): Promise<EnqueueResult> => {
      if (options.reject) return { accepted: [], rejected: targets }
      const item = meta({
        sourcePath: targets[0],
        requestedBy: enqueueOptions?.requestedBy,
        ...(options.processing ? { status: 'processing' as const } : {})
      })
      tracker.onQueueEvent({ type: 'job', meta: item })
      enqueued.push({ paths: targets, ...(enqueueOptions ? { options: enqueueOptions } : {}) })
      return { accepted: [item], rejected: [] }
    }
  }
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    model: 'small',
    mcp: { enabled: true, allowTranscribe: true },
    ...options.settings
  }
  const server = await startBridgeServer({
    paths,
    tracker,
    queue,
    settings: { get: () => settings },
    platform: process.platform,
    ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
    version: '9.9.9'
  })
  const token = (JSON.parse(await readFile(paths.mcpBridgeInfo, 'utf8')) as { token: string }).token
  return { root, paths, token, tracker, enqueued, server }
}

let open: Harness[] = []
let rawServers: { close(): Promise<void> }[] = []

async function trackedHarness(...args: Parameters<typeof harness>): Promise<Harness> {
  const context = await harness(...args)
  open.push(context)
  return context
}

/** Servidor cru: responde o que o teste mandar, sem passar pela ponte real. */
async function rawBridge(
  handler: (socket: Socket) => void
): Promise<{ address: string; close(): Promise<void> }> {
  const root = await makeTempDir()
  const address = join(root, 'raw.sock')
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => {
      sockets.delete(socket)
    })
    handler(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      reject(error)
    })
    server.listen(address, () => {
      resolve()
    })
  })
  const raw = {
    address,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await rm(root, { recursive: true, force: true })
    }
  }
  rawServers.push(raw)
  return raw
}

async function writeBridgeInfo(paths: AppPaths, address: string, token = 't'): Promise<void> {
  await mkdir(join(paths.root, 'mcp'), { recursive: true })
  await writeFile(paths.mcpBridgeInfo, JSON.stringify({ address, token, pid: process.pid }))
}

/** Registra uma pasta temporária para limpeza, sem servidor associado. */
function trackRoot(root: string): AppPaths {
  const paths = appPaths(root)
  open.push({
    root,
    paths,
    token: '',
    tracker: new ActivityTracker(),
    enqueued: [],
    server: { address: '', close: () => Promise.resolve() }
  })
  return paths
}

beforeEach(() => {
  open = []
  rawServers = []
})

afterEach(async () => {
  await Promise.all(open.map((context) => context.server.close()))
  await Promise.all(rawServers.map((server) => server.close()))
  await Promise.all(open.map((context) => rm(context.root, { recursive: true, force: true })))
})

describe('bridgeAddress', () => {
  it('uses the unix socket in the app data dir when the path is short enough', () => {
    const paths = appPaths('/home/user/.config/Whisper Transcriber')
    expect(bridgeAddress({ paths, platform: 'linux' })).toBe(paths.mcpBridgeSocket)
  })

  it('falls back to tmpdir for long socket paths and win32 uses a named pipe', () => {
    const longPaths = appPaths(`/${'a'.repeat(120)}`)
    const address = bridgeAddress({
      paths: longPaths,
      platform: 'linux',
      tmpdir: () => '/tmp',
      uid: () => '1000'
    })
    expect(address).toBe('/tmp/whisper-transcriber-1000.sock')

    const defaultUid = bridgeAddress({ paths: longPaths, platform: 'linux', tmpdir: () => '/tmp' })
    expect(defaultUid).toMatch(/^\/tmp\/whisper-transcriber-\d+\.sock$/)

    const pipe = bridgeAddress({
      paths: appPaths('/x'),
      platform: 'win32',
      env: { USERNAME: 'Eldevan' }
    })
    expect(pipe.startsWith('\\\\.\\pipe\\whisper-transcriber-')).toBe(true)
    expect(pipe).not.toContain('Eldevan')

    const anonymous = bridgeAddress({ paths: appPaths('/x'), platform: 'win32' })
    expect(anonymous.startsWith('\\\\.\\pipe\\whisper-transcriber-')).toBe(true)
  })

  it('hashes the user when the platform has no uid', () => {
    const original = process.getuid
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
    try {
      const longPaths = appPaths(`/${'a'.repeat(120)}`)
      const withUser = bridgeAddress({
        paths: longPaths,
        platform: 'linux',
        tmpdir: () => '/tmp',
        env: { USERNAME: 'x' }
      })
      expect(withUser).toMatch(/^\/tmp\/whisper-transcriber-[0-9a-f]{12}\.sock$/)
      const anonymous = bridgeAddress({ paths: longPaths, platform: 'linux', tmpdir: () => '/tmp' })
      expect(anonymous).toMatch(/^\/tmp\/whisper-transcriber-[0-9a-f]{12}\.sock$/)
    } finally {
      Object.defineProperty(process, 'getuid', { value: original, configurable: true })
    }
  })

  it('uses the OS tmpdir by default for long socket paths', () => {
    const address = bridgeAddress({
      paths: appPaths(`/${'a'.repeat(120)}`),
      platform: 'linux'
    })
    expect(address).toMatch(/whisper-transcriber-\d+\.sock$/)
  })

  it('creates and removes the unix socket directory but does nothing for win32', async () => {
    const root = await makeTempDir()
    const address = join(root, 'mcp', 'bridge.sock')
    await ensureSocketDir(address, 'linux')
    expect((await stat(join(root, 'mcp'))).isDirectory()).toBe(true)
    await writeFile(address, 'x')
    await removeSocket(address, 'linux')
    await expect(stat(address)).rejects.toThrow()
    await ensureSocketDir(address, 'win32')
    await removeSocket(address, 'win32')
    await rm(root, { recursive: true, force: true })
  })
})

describe('bridge server limits', () => {
  it('exposes the spec limits', () => {
    expect(AUTH_TIMEOUT_MS).toBe(10_000)
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024)
  })

  it('closes when the token is wrong', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: 'wrong-token' })
    await conn.closed
  })

  it('closes on a message bigger than 64 KB', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.raw('a'.repeat(MAX_MESSAGE_BYTES + 10))
    await conn.closed
  })

  it('closes when no valid auth arrives in time', async () => {
    const context = await trackedHarness({ authTimeoutMs: 30 })
    const conn = await Conn.open(context.server.address)
    await conn.closed
  })

  it('closes when the first message is not auth', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'ping', rid: 1, token: context.token })
    await conn.closed
  })

  it('survives a client that disconnects before the response', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/aula.mp4', client: 'codex' })
    conn.end()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await Conn.open(context.server.address)
    again.send({ type: 'auth', rid: 1, token: context.token })
    expect(await again.next()).toMatchObject({ type: 'ok' })
    again.end()
  })

  it('closes on an invalid message', async () => {
    const context = await trackedHarness()
    const first = await Conn.open(context.server.address)
    first.raw('not-json\n')
    await first.closed

    const second = await Conn.open(context.server.address)
    second.send({ type: 'nope', rid: 1 })
    await second.closed
  })

  it('writes bridge.json with mode 0600 and deletes it on close', async () => {
    const context = await trackedHarness()
    expect((await stat(context.paths.mcpBridgeInfo)).mode & 0o777).toBe(0o600)
    await context.server.close()
    await expect(stat(context.paths.mcpBridgeInfo)).rejects.toThrow()
  })

  it('replaces a stale unix socket left by an unclean exit', async () => {
    const context = await trackedHarness({ staleSocket: true })
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    expect(await conn.next()).toMatchObject({ type: 'ok' })
    conn.send({ type: 'ping', rid: 2 })
    expect(await conn.next()).toMatchObject({ type: 'ok', data: { ready: true } })
    conn.end()
  })
})

describe('bridge server requests', () => {
  it('auth unlocks ping and activity', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    expect(await conn.next()).toMatchObject({ type: 'ok', data: { appVersion: '9.9.9' } })
    conn.send({ type: 'ping', rid: 2 })
    expect(await conn.next()).toMatchObject({
      type: 'ok',
      data: { appVersion: '9.9.9', ready: true }
    })
    conn.send({ type: 'activity', rid: 3 })
    expect(await conn.next()).toMatchObject({
      type: 'ok',
      data: { appRunning: true, current: null, pending: [], live: null }
    })
    conn.send({ type: 'auth', rid: 4, token: context.token })
    expect(await conn.next()).toMatchObject({ type: 'ok', data: { appVersion: '9.9.9' } })
    conn.end()
  })

  it('reports position 1 for an item already processing', async () => {
    const context = await trackedHarness({ processing: true })
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/aula.mp4', client: 'codex' })
    expect((await conn.next<ResponseShape>()).data).toMatchObject({ status: 'queued', position: 1 })
    conn.send({ type: 'transcribe', rid: 3, path: '/tmp/aula2.mp4', client: 'codex' })
    expect((await conn.next<ResponseShape>()).data).toMatchObject({ status: 'queued' })
    conn.end()
  })

  it('falls back to position 1 and ignores app-requested pending items', async () => {
    const tracker = new ActivityTracker()
    tracker.onQueueEvent({ type: 'job', meta: meta() })
    const context = await trackedHarness({
      tracker,
      queue: { enqueue: async () => ({ accepted: [meta({ requestedBy: 'codex' })], rejected: [] }) }
    })
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/aula.mp4', client: 'codex' })
    expect((await conn.next<ResponseShape>()).data).toMatchObject({ position: 1 })
    conn.end()
  })

  it('status returns the job progress or null', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/aula.mp4', client: 'codex' })
    const created = await conn.next<ResponseShape>()
    const id = created.data!.id
    conn.send({ type: 'status', rid: 3, id })
    expect((await conn.next<ResponseShape>()).data).toMatchObject({
      id,
      phase: 'loading_model',
      pct: 0
    })
    conn.send({ type: 'status', rid: 4, id: randomUUID() })
    expect((await conn.next<ResponseShape>()).data).toBeNull()
    conn.end()
  })

  it('transcribe refuses when the key is off or setup is pending', async () => {
    const disabled = await trackedHarness({
      settings: { mcp: { enabled: true, allowTranscribe: false } }
    })
    const first = await Conn.open(disabled.server.address)
    first.send({ type: 'auth', rid: 1, token: disabled.token })
    await first.next()
    first.send({ type: 'transcribe', rid: 2, path: '/tmp/a.mp4', client: 'codex' })
    expect((await first.next<ResponseShape>()).error?.code).toBe('TRANSCRIBE_DISABLED')
    first.end()

    const pending = await trackedHarness({ settings: { model: null } })
    const second = await Conn.open(pending.server.address)
    second.send({ type: 'auth', rid: 1, token: pending.token })
    await second.next()
    second.send({ type: 'transcribe', rid: 2, path: '/tmp/a.mp4', client: 'codex' })
    expect((await second.next<ResponseShape>()).error?.code).toBe('SETUP_INCOMPLETE')
    second.end()
  })

  it('transcribe rejects unsupported files and queue refusals', async () => {
    const context = await trackedHarness({ reject: true })
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/nota.pdf', client: 'codex' })
    expect((await conn.next<ResponseShape>()).error?.code).toBe('UNSUPPORTED_FILE')
    conn.send({ type: 'transcribe', rid: 3, path: '/tmp/aula.mp4', client: 'codex' })
    expect((await conn.next<ResponseShape>()).error?.code).toBe('FILE_NOT_FOUND')
    conn.end()
  })

  it('transcribe enqueues with requestedBy and returns the id', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'transcribe', rid: 2, path: '/tmp/aula.mp4', client: 'claude-code' })
    const response = await conn.next<ResponseShape>()
    expect(response).toMatchObject({ type: 'ok', data: { status: 'queued' } })
    expect(context.enqueued[0]?.options?.requestedBy).toBe('claude-code')
    conn.end()
  })

  it('refuses the 11th pending AI request with QUEUE_BUSY', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    for (let index = 0; index < 11; index++) {
      conn.send({
        type: 'transcribe',
        rid: 10 + index,
        path: `/tmp/aula${index}.mp4`,
        client: 'codex'
      })
      const response = await conn.next<ResponseShape>()
      if (index < 10) expect(response.data).toBeDefined()
      else expect(response.error?.code).toBe('QUEUE_BUSY')
    }
    expect(context.enqueued).toHaveLength(10)
    conn.end()
  })

  it('closes when a request fails the schema after auth', async () => {
    const context = await trackedHarness()
    const conn = await Conn.open(context.server.address)
    conn.send({ type: 'auth', rid: 1, token: context.token })
    await conn.next()
    conn.send({ type: 'status', rid: 2, id: 'not-a-uuid' })
    await conn.closed
  })
})

describe('BridgeClient', () => {
  it('connects, reads activity/status and enqueues', async () => {
    const context = await trackedHarness()
    const client = new BridgeClient(context.paths)
    await expect(client.connect()).resolves.toEqual({ appVersion: '9.9.9', ready: true })
    expect(await client.activity()).toMatchObject({ appRunning: true })
    const created = await client.transcribe('/tmp/aula.mp4', 'codex')
    expect(await client.status(created.id)).toMatchObject({ id: created.id })
    expect(await client.status(randomUUID())).toBeNull()
  })

  it('reports the app as unavailable without bridge.json', async () => {
    const root = await makeTempDir()
    const paths = trackRoot(root)
    const client = new BridgeClient(paths)
    await expect(client.connect()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  })

  it('surfaces an error response from the bridge', async () => {
    const context = await trackedHarness({
      settings: { mcp: { enabled: true, allowTranscribe: false } }
    })
    const client = new BridgeClient(context.paths)
    await expect(client.transcribe('/tmp/aula.mp4', 'codex')).rejects.toMatchObject({
      code: 'TRANSCRIBE_DISABLED'
    })
  })

  it('times out when the bridge never answers', async () => {
    const raw = await rawBridge(() => undefined)
    const paths = trackRoot(await makeTempDir())
    await writeBridgeInfo(paths, raw.address)
    const client = new BridgeClient(paths, { timeoutMs: 20 })
    await expect(client.connect()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  })

  it('reports unavailable when the bridge socket is dead', async () => {
    const paths = trackRoot(await makeTempDir())
    await writeBridgeInfo(paths, join(paths.root, 'missing.sock'))
    const client = new BridgeClient(paths)
    await expect(client.connect()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  })

  it('rejects garbage or auth errors from a foreign bridge', async () => {
    const garbage = await rawBridge((socket) => {
      socket.write('not-json\n')
    })
    const garbagePaths = trackRoot(await makeTempDir())
    await writeBridgeInfo(garbagePaths, garbage.address)
    await expect(new BridgeClient(garbagePaths).connect()).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE'
    })

    const denied = await rawBridge((socket) => {
      socket.write(
        `${JSON.stringify({ type: 'error', rid: 1, error: { code: 'WORKER_UNAVAILABLE', message: 'no' } })}\n`
      )
    })
    const deniedPaths = trackRoot(await makeTempDir())
    await writeBridgeInfo(deniedPaths, denied.address)
    await expect(new BridgeClient(deniedPaths).connect()).rejects.toMatchObject({
      message: 'no'
    })
  })

  it('rejects valid JSON that is not a bridge response', async () => {
    const raw = await rawBridge((socket) => {
      socket.write('{"nope":true}\n')
    })
    const paths = trackRoot(await makeTempDir())
    await writeBridgeInfo(paths, raw.address)
    await expect(new BridgeClient(paths).connect()).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE'
    })
  })

  it('ignores bridge messages for other requests', async () => {
    const raw = await rawBridge((socket) => {
      socket.write(`${JSON.stringify({ type: 'ok', rid: 1, data: {} })}\n`)
      socket.write(`${JSON.stringify({ type: 'ok', rid: 99, data: {} })}\n`)
      socket.write(
        `${JSON.stringify({ type: 'ok', rid: 2, data: { appVersion: '1', ready: true } })}\n`
      )
    })
    const paths = trackRoot(await makeTempDir())
    await writeBridgeInfo(paths, raw.address)
    await expect(new BridgeClient(paths).connect()).resolves.toEqual({
      appVersion: '1',
      ready: true
    })
  })

  it('rejects a bridge.json with the wrong shape', async () => {
    const paths = trackRoot(await makeTempDir())
    await mkdir(join(paths.root, 'mcp'), { recursive: true })
    await writeFile(paths.mcpBridgeInfo, JSON.stringify({ address: '/nowhere' }))
    await expect(new BridgeClient(paths).connect()).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE'
    })
  })

  it('keeps polling after a status failure', async () => {
    const context = await trackedHarness()
    const client = new BridgeClient(context.paths, { pollMs: 5 })
    let seen = 0
    const stop = client.subscribeProgress(randomUUID(), () => {
      seen += 1
    })
    await context.server.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    expect(seen).toBe(0)
  })

  it('subscribes to progress by polling and unsubscribes', async () => {
    const context = await trackedHarness()
    const client = new BridgeClient(context.paths, { pollMs: 10 })
    const created = await client.transcribe('/tmp/aula.mp4', 'codex')
    const seen: (string | null)[] = []
    const stop = client.subscribeProgress(created.id, (progress) => {
      seen.push(progress?.id ?? null)
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    expect(seen[0]).toBe(created.id)
  })
})

describe('createLiveBridge', () => {
  it('opens the app only for transcribe and maps the outcome', async () => {
    const client: BridgeClientLike = {
      connect: vi.fn(async () => ({ appVersion: '1', ready: true })),
      activity: vi.fn(async () => ({ appRunning: false, current: null, pending: [], live: null })),
      status: vi.fn(async () => null),
      transcribe: vi.fn(async () => ({ id: randomUUID(), position: 2 }))
    }
    const ensureRunning = vi.fn(async () => undefined)
    const bridge = createLiveBridge({ client, ensureRunning })
    await bridge.activity()
    await bridge.status(randomUUID())
    expect(ensureRunning).not.toHaveBeenCalled()
    const outcome = await bridge.transcribe('/tmp/a.mp4', 'codex', false)
    expect(ensureRunning).toHaveBeenCalledOnce()
    expect(outcome).toMatchObject({ status: 'queued', position: 2 })
  })

  it('propagates a refused setup', async () => {
    const client: BridgeClientLike = {
      connect: vi.fn(),
      activity: vi.fn(),
      status: vi.fn(),
      transcribe: vi.fn()
    }
    const bridge = createLiveBridge({
      client,
      ensureRunning: async () => {
        throw new AppError('SETUP_INCOMPLETE', 'Finish setup')
      }
    })
    await expect(bridge.transcribe('/tmp/a.mp4', 'codex', true)).rejects.toMatchObject({
      code: 'SETUP_INCOMPLETE'
    })
  })

  it('omits the position when the client does not return one', async () => {
    const client: BridgeClientLike = {
      connect: vi.fn(),
      activity: vi.fn(),
      status: vi.fn(),
      transcribe: vi.fn(async () => ({ id: randomUUID() }))
    }
    const bridge = createLiveBridge({ client, ensureRunning: async () => undefined })
    await expect(bridge.transcribe('/tmp/a.mp4', 'codex', false)).resolves.toMatchObject({
      status: 'queued'
    })
  })
})
