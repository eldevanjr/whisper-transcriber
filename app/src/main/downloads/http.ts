import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { AppError } from '../../shared/errors'
import { isAllowedHost } from './manifest'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface DownloadOptions {
  url: string
  dest: string
  size: number
  sha256: string
  fetch: FetchFn
  signal?: AbortSignal
  onProgress?: (received: number) => void
}

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>
  delays?: number[]
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const DEFAULT_DELAYS = [1000, 2000, 4000]

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function assertAllowed(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    throw new AppError(
      'HOST_NOT_ALLOWED',
      'Download bloqueado: servidor não permitido',
      parsed.host
    )
  }
}

export async function fetchAllowed(
  url: string,
  init: RequestInit,
  fetchFn: FetchFn
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowed(current)
    const response = await fetchFn(current, { ...init, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new AppError('DOWNLOAD_FAILED', 'Redirecionamento sem destino', current)
    current = new URL(location, current).toString()
  }
  throw new AppError('DOWNLOAD_FAILED', 'Redirecionamentos demais', url)
}

async function partialSize(part: string, expected: number): Promise<number> {
  try {
    const { size } = await stat(part)
    if (size <= expected) return size
    await rm(part, { force: true })
  } catch {
    // sem .part: começa do zero
  }
  return 0
}

async function hashInto(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
}

async function openBody(
  options: DownloadOptions,
  offset: number
): Promise<{ body: ReadableStream<Uint8Array>; resumed: boolean }> {
  const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {}
  const init: RequestInit = options.signal ? { headers, signal: options.signal } : { headers }
  const response = await fetchAllowed(options.url, init, options.fetch)
  if (!response.ok || response.body === null) {
    throw new AppError('DOWNLOAD_FAILED', `Servidor respondeu HTTP ${response.status}`, options.url)
  }
  // 206 = retomada; 200 = o servidor ignorou o Range e mandou tudo de novo
  return { body: response.body, resumed: offset > 0 && response.status === 206 }
}

async function transfer(options: DownloadOptions, part: string, offset: number): Promise<Hash> {
  const { body, resumed } = await openBody(options, offset)
  const hash = createHash('sha256')
  let received = 0
  if (resumed) {
    await hashInto(part, hash)
    received = offset
  }
  const handle = await open(part, resumed ? 'a' : 'w')
  try {
    for await (const chunk of body) {
      await handle.write(chunk)
      hash.update(chunk)
      received += chunk.byteLength
      options.onProgress?.(received)
    }
  } finally {
    await handle.close()
  }
  return hash
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const part = `${options.dest}.part`
  const offset = await partialSize(part, options.size)
  options.onProgress?.(offset)
  let hash: Hash
  if (offset === options.size) {
    hash = createHash('sha256')
    await hashInto(part, hash)
  } else {
    hash = await transfer(options, part, offset)
  }
  if (hash.digest('hex') !== options.sha256) {
    await rm(part, { force: true })
    throw new AppError('HASH_MISMATCH', 'O arquivo baixado não confere (hash)', options.dest)
  }
  await rename(part, options.dest)
}

function normalize(error: unknown, signal: AbortSignal | undefined): AppError {
  if (signal?.aborted) return new AppError('CANCELED', 'Download cancelado')
  if (error instanceof AppError) return error
  return new AppError('DOWNLOAD_FAILED', 'Falha de conexão durante o download', String(error))
}

/** Espera antes da próxima tentativa, ou null para desistir. */
function nextDelay(failure: AppError, schedule: number[], hashRetried: boolean): number | null {
  if (failure.code === 'HASH_MISMATCH') return hashRetried ? null : 0 // refaz na hora, uma única vez
  if (failure.code !== 'DOWNLOAD_FAILED') return null
  return schedule.shift() ?? null
}

export async function downloadWithRetry(
  options: DownloadOptions,
  retry: RetryOptions = {}
): Promise<void> {
  const sleep = retry.sleep ?? defaultSleep
  const schedule = [...(retry.delays ?? DEFAULT_DELAYS)]
  let hashRetried = false
  for (;;) {
    try {
      await downloadFile(options)
      return
    } catch (error) {
      const failure = normalize(error, options.signal)
      const wait = nextDelay(failure, schedule, hashRetried)
      if (wait === null) throw failure
      if (failure.code === 'HASH_MISMATCH') hashRetried = true
      await sleep(wait)
    }
  }
}
