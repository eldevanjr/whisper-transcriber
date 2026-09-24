import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { AppError } from '../shared/errors'
import { pathExists } from './fs-utils'
import type { HistoryStore } from './history/store'

export const MEDIA_SCHEME = 'app-media'

// O áudio só passa a existir no meio do job: um 404 em cache deixaria o player quebrado.
const NO_STORE = 'no-store'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma'
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

interface ByteRange {
  start: number
  end: number
}

function suffixRange(rawLength: string, size: number): ByteRange | 'invalid' {
  const length = Number(rawLength)
  return rawLength === '' || length === 0
    ? 'invalid'
    : { start: Math.max(size - length, 0), end: size - 1 }
}

function absoluteRange(start: number, rawEnd: string, size: number): ByteRange | 'invalid' {
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  return start > end || start >= size ? 'invalid' : { start, end }
}

export function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  // Os dois grupos (\d*) sempre participam do match: nunca são undefined.
  const rawStart = String(match[1])
  const rawEnd = String(match[2])
  return rawStart === '' ? suffixRange(rawEnd, size) : absoluteRange(Number(rawStart), rawEnd, size)
}

interface MediaFile {
  path: string
  fallback: boolean
}

type MediaHistory = Pick<HistoryStore, 'get' | 'paths'>

async function resolveMedia(
  history: MediaHistory,
  id: string,
  pathname: string
): Promise<MediaFile> {
  const { audio, dir } = history.paths(id) // valida o id antes de qualquer acesso ao disco
  if (pathname === '/audio') return { path: audio, fallback: false }
  // Ao vivo: cada lado da conversa (o /audio é a mistura).
  if (pathname === '/voce' || pathname === '/outros') {
    return { path: join(dir, `${pathname.slice(1)}.m4a`), fallback: false }
  }
  if (pathname !== '/video') throw new AppError('NOT_FOUND', 'Mídia não encontrada')
  const meta = await history.get(id)
  if (meta.mediaKind === 'video' && (await pathExists(meta.sourcePath))) {
    return { path: meta.sourcePath, fallback: false }
  }
  return { path: audio, fallback: meta.mediaKind === 'video' }
}

async function serveFile(file: MediaFile, rangeHeader: string | null): Promise<Response> {
  const { size } = await stat(file.path)
  const headers = new Headers({
    'Content-Type': contentTypeFor(file.path),
    'Accept-Ranges': 'bytes',
    'Cache-Control': NO_STORE
  })
  if (file.fallback) headers.set('X-Media-Fallback', '1')
  if (size === 0) return new Response(null, { status: 200, headers })
  const range = parseRange(rangeHeader, size)
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const { start, end } = range ?? { start: 0, end: size - 1 }
  headers.set('Content-Length', String(end - start + 1))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const body = Readable.toWeb(
    createReadStream(file.path, { start, end })
  ) as ReadableStream<Uint8Array>
  return new Response(body, { status: range ? 206 : 200, headers })
}

export function createMediaHandler(deps: {
  history: MediaHistory
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url)
      return await serveFile(
        await resolveMedia(deps.history, url.hostname, url.pathname),
        request.headers.get('range')
      )
    } catch {
      return new Response('Não encontrado', {
        status: 404,
        headers: { 'Cache-Control': NO_STORE }
      })
    }
  }
}
