import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir as osTmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AppError, toAppError } from '../../shared/errors'
import type { EnqueueResult } from '../../shared/events'
import type { HistoryMeta } from '../../shared/history'
import { mediaKindOf } from '../../shared/media'
import { BridgeRequestSchema, type BridgeRequest, type BridgeResponse } from '../../shared/mcp'
import type { Settings } from '../../shared/settings'
import type { AppPaths } from '../paths'
import type { ActivityTracker } from './activity-tracker'

/** Sem `auth` válido nesse tempo, a conexão é fechada (spec §7.2 / §15). */
export const AUTH_TIMEOUT_MS = 10_000
/** Mensagem maior que isso fecha a conexão (spec §15). */
export const MAX_MESSAGE_BYTES = 64 * 1024
/** Máximo de itens pedidos por IA aguardando na fila (spec §14). */
export const MAX_AI_PENDING = 10

export interface BridgeQueue {
  enqueue(paths: string[], options?: { requestedBy?: string }): Promise<EnqueueResult>
}

export interface BridgeAddressInput {
  paths: AppPaths
  platform: NodeJS.Platform
  tmpdir?: () => string
  uid?: () => string
  env?: NodeJS.ProcessEnv
}

export interface BridgeServerDeps {
  paths: AppPaths
  tracker: ActivityTracker
  queue: BridgeQueue
  settings: { get(): Settings }
  platform: NodeJS.Platform
  version: string
  authTimeoutMs?: number
  tmpdir?: () => string
  uid?: () => string
  env?: NodeJS.ProcessEnv
}

export interface BridgeServer {
  address: string
  close(): Promise<void>
}

/** Endereço local da ponte (spec §7.1): socket Unix ou named pipe; sem nenhuma porta TCP. */
export function bridgeAddress(input: BridgeAddressInput): string {
  if (input.platform === 'win32') {
    const user = input.env?.USERNAME ?? ''
    return `\\\\.\\pipe\\whisper-transcriber-${shortHash(user)}`
  }
  if (Buffer.byteLength(input.paths.mcpBridgeSocket) > 100) {
    return join((input.tmpdir ?? osTmpdir)(), `whisper-transcriber-${userId(input)}.sock`)
  }
  return input.paths.mcpBridgeSocket
}

/** Sobe a ponte, grava o `bridge.json` 0600 e devolve o handle de fechamento (spec §7). */
export async function startBridgeServer(deps: BridgeServerDeps): Promise<BridgeServer> {
  const address = bridgeAddress({
    paths: deps.paths,
    platform: deps.platform,
    tmpdir: deps.tmpdir,
    uid: deps.uid,
    env: deps.env
  })
  const token = randomBytes(32).toString('base64url')
  await ensureSocketDir(address, deps.platform)
  // Uma saída suja deixa o socket Unix para trás e o listen falharia com EADDRINUSE. Como só o
  // app (single-instance) sobe a ponte, o endereço é nosso: limpa antes de reabrir. No Windows o
  // named pipe não tem arquivo, então nada é removido.
  await removeSocket(address, deps.platform)
  const context: ServerContext = {
    token,
    version: deps.version,
    authTimeoutMs: deps.authTimeoutMs ?? AUTH_TIMEOUT_MS,
    tracker: deps.tracker,
    queue: deps.queue,
    settings: deps.settings
  }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', noop)
    socket.on('close', () => {
      sockets.delete(socket)
    })
    new BridgeConnection(socket, context)
  })
  await listen(server, address)
  await writeBridgeInfo(deps.paths.mcpBridgeInfo, {
    address,
    token,
    pid: process.pid,
    version: deps.version
  })
  let closed = false
  return {
    address,
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
      await rm(deps.paths.mcpBridgeInfo, { force: true })
      await removeSocket(address, deps.platform)
    }
  }
}

/** No Windows o endereço é um named pipe e não há pasta para criar (spec §7.1). */
export async function ensureSocketDir(address: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return
  await mkdir(dirname(address), { recursive: true, mode: 0o700 })
}

/** Apaga o socket Unix ao fechar; no Windows não há arquivo (spec §7.1). */
export async function removeSocket(address: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return
  await rm(address, { force: true })
}

interface ServerContext {
  token: string
  version: string
  authTimeoutMs: number
  tracker: ActivityTracker
  queue: BridgeQueue
  settings: { get(): Settings }
}

/** Uma conexão da ponte: autentica na primeira mensagem e responde cada requisição. */
class BridgeConnection {
  private buffer = ''
  private authed = false
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly socket: Socket,
    private readonly context: ServerContext
  ) {
    socket.setEncoding('utf8')
    this.timer = setTimeout(() => socket.destroy(), context.authTimeoutMs)
    socket.on('data', (chunk: string) => {
      this.onData(chunk)
    })
    socket.on('close', () => {
      clearTimeout(this.timer)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) {
      this.socket.destroy()
      return
    }
    for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.onLine(line)
      if (this.socket.destroyed) return
    }
  }

  private onLine(line: string): void {
    const request = parseRequest(line)
    if (!request) {
      this.socket.destroy()
      return
    }
    if (!this.authed) {
      this.authenticate(request)
      return
    }
    void respondTo(request, this.context).then((response) => {
      this.reply(response)
    })
  }

  private authenticate(request: BridgeRequest): void {
    if (request.type !== 'auth' || !tokenMatches(request.token, this.context.token)) {
      this.socket.destroy()
      return
    }
    this.authed = true
    clearTimeout(this.timer)
    this.reply({ type: 'ok', rid: request.rid, data: { appVersion: this.context.version } })
  }

  private reply(response: BridgeResponse): void {
    this.socket.write(`${JSON.stringify(response)}\n`)
  }
}

async function respondTo(request: BridgeRequest, context: ServerContext): Promise<BridgeResponse> {
  switch (request.type) {
    case 'auth':
      return ok(request.rid, { appVersion: context.version })
    case 'ping':
      return ok(request.rid, {
        appVersion: context.version,
        ready: context.settings.get().model !== null
      })
    case 'activity':
      return ok(request.rid, context.tracker.snapshot())
    case 'status':
      return ok(request.rid, context.tracker.progressOf(request.id))
    case 'transcribe':
      return transcribe(request, context)
  }
}

async function transcribe(
  request: Extract<BridgeRequest, { type: 'transcribe' }>,
  context: ServerContext
): Promise<BridgeResponse> {
  try {
    const created = await createJob(request, context)
    return ok(request.rid, {
      id: created.id,
      status: 'queued',
      position: positionOf(context.tracker, created.id)
    })
  } catch (error) {
    const info = toAppError(error).toInfo()
    return { type: 'error', rid: request.rid, error: info }
  }
}

async function createJob(
  request: Extract<BridgeRequest, { type: 'transcribe' }>,
  context: ServerContext
): Promise<HistoryMeta> {
  const settings = context.settings.get()
  if (!settings.mcp.allowTranscribe) {
    throw new AppError(
      'TRANSCRIBE_DISABLED',
      'Transcribing via AI is turned off in Whisper Transcriber settings.'
    )
  }
  if (settings.model === null) {
    throw new AppError('SETUP_INCOMPLETE', 'Finish Whisper Transcriber setup and try again.')
  }
  if (countAiPending(context.tracker) >= MAX_AI_PENDING) {
    throw new AppError('QUEUE_BUSY', 'Too many AI transcription requests are already queued.')
  }
  if (mediaKindOf(request.path) === null) {
    throw new AppError('UNSUPPORTED_FILE', 'Unsupported media file extension', request.path)
  }
  const result = await context.queue.enqueue([request.path], { requestedBy: request.client })
  const created = result.accepted[0]
  if (!created) throw new AppError('FILE_NOT_FOUND', 'File not found or not readable', request.path)
  return created
}

function countAiPending(tracker: ActivityTracker): number {
  const snapshot = tracker.snapshot()
  let count = snapshot.current?.requestedBy === undefined ? 0 : 1
  for (const item of snapshot.pending) {
    if (item.requestedBy !== undefined) count++
  }
  return count
}

function positionOf(tracker: ActivityTracker, id: string): number {
  const snapshot = tracker.snapshot()
  if (snapshot.current?.id === id) return 1
  const index = snapshot.pending.findIndex((item) => item.id === id)
  return index < 0 ? 1 : index + 1
}

function parseRequest(line: string): BridgeRequest | null {
  try {
    const parsed = BridgeRequestSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function tokenMatches(received: string, expected: string): boolean {
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function ok(rid: number, data: unknown): BridgeResponse {
  return { type: 'ok', rid, data }
}

async function writeBridgeInfo(path: string, info: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function userId(input: BridgeAddressInput): string {
  if (input.uid) return input.uid()
  const uid = process.getuid?.()
  return uid === undefined ? shortHash(input.env?.USERNAME ?? '') : String(uid)
}

function noop(): void {
  // Um erro no socket (ECONNRESET) não pode derrubar o app.
}
