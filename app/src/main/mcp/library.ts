import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { AppError, type ErrorInfo } from '../../shared/errors'
import {
  paragraphsToText,
  speakerPrefix,
  toJson,
  toParagraphs,
  toTimestamped,
  type SpeakerLabels
} from '../../shared/format'
import type { HistoryMeta, JobStatus, TranscriptEntry } from '../../shared/history'
import { contentTypeFor, sanitizeFileName } from '../../shared/media'
import type { Track } from '../../shared/settings'
import { pathExists, writeFileAtomic } from '../fs-utils'
import type { HistoryStore } from '../history/store'

/** Página de `get_transcription`: ~40 000 caracteres, cortada entre trechos/parágrafos (spec §9.3). */
export const PAGE_CHARS = 40000
const SNIPPET_CHARS = 120
const LIST_DEFAULT = 20
const LIMIT_MAX = 100

export type ReadFormat = 'text' | 'timestamped' | 'json'
export type ReadVersion = 'active' | 'live' | 'redo'
export type AudioTrack = 'mix' | 'voce' | 'outros' | 'source'
export type ExportFormat = 'txt' | 'timestamped' | 'json'

export interface ItemFilter {
  kind?: 'file' | 'live'
  since?: string
  until?: string
}

export interface ListFilter extends ItemFilter {
  query?: string
  status?: JobStatus
  limit?: number
  offset?: number
}

export interface SearchFilter extends ItemFilter {
  limit?: number
}

export interface ListedTranscription {
  id: string
  title: string
  createdAt: string
  durationS: number | null
  language: string | null
  kind: 'file' | 'live'
  status: JobStatus
  tracks?: Track[]
  requestedBy?: string
  hasRedo: boolean
  error: ErrorInfo | null
}

export interface SearchHit {
  id: string
  title: string
  createdAt: string
  start: number
  end: number
  speaker?: Track
  snippet: string
}

export interface ReadOptions {
  format?: ReadFormat
  version?: ReadVersion
  fromS?: number
  toS?: number
  cursor?: string
}

export interface ReadResult {
  meta: ListedTranscription
  content: string
  nextCursor: string | null
  inProgress: boolean
  range: { fromS: number | null; toS: number | null }
  totalSegments: number
}

export interface AudioResult {
  path: string
  mime: string
  bytes: number
  durationS: number | null
}

const CursorPayloadSchema = z.object({
  i: z.number().int().min(0),
  f: z.enum(['text', 'timestamped', 'json']),
  v: z.enum(['active', 'live', 'redo']),
  a: z.number().optional(),
  b: z.number().optional()
})
type CursorPayload = z.infer<typeof CursorPayloadSchema>

/**
 * Leitura do histórico para as IAs (spec §9.1–9.5): lista, busca, leitura paginada por trechos,
 * trechos incrementais, áudio e exportação. Só lê o disco; nada aqui abre o app ou usa a fila.
 */
export class TranscriptLibrary {
  constructor(
    private readonly history: HistoryStore,
    private readonly labels: SpeakerLabels
  ) {}

  async list(filter: ListFilter = {}): Promise<{ items: ListedTranscription[]; total: number }> {
    const { entries } = await this.history.list()
    const matched = entries.filter((meta) => matchesFilter(meta, filter))
    const limit = clamp(filter.limit ?? LIST_DEFAULT, 1, LIMIT_MAX)
    const offset = Math.max(0, Math.floor(filter.offset ?? 0))
    const page = matched.slice(offset, offset + limit)
    const items = await Promise.all(page.map((meta) => this.listItem(meta)))
    return { items, total: matched.length }
  }

  /** Um item do histórico no mesmo formato de `list` (spec §9.6/§9.7). */
  async get(id: string): Promise<ListedTranscription> {
    return this.listItem(await this.history.get(id))
  }

  async search(query: string, filter: SearchFilter = {}): Promise<SearchHit[]> {
    if (query.length < 2 || query.length > 200) {
      throw new AppError('INVALID_REQUEST', 'A busca precisa ter de 2 a 200 caracteres')
    }
    const needle = fold(query).text
    if (needle === '') return []
    const max = clamp(filter.limit ?? LIST_DEFAULT, 1, LIMIT_MAX)
    const { entries } = await this.history.list()
    const hits: SearchHit[] = []
    for (const meta of entries) {
      if (!matchesItem(meta, filter)) continue
      const transcript = sortByStart(await this.history.readActive(meta))
      collectHits(meta, transcript, needle, hits)
      if (hits.length >= max) break
    }
    return hits.slice(0, max)
  }

  async read(id: string, options: ReadOptions = {}): Promise<ReadResult> {
    const meta = await this.history.get(id)
    const format = options.format ?? 'text'
    const version = options.version ?? 'active'
    validateRange(options.fromS, options.toS)
    const entries = await this.versionEntries(meta, version)
    const selected = withinRange(entries, options.fromS, options.toS)
    const blocks = buildBlocks(selected, format, this.labels)
    const bounds = blockBounds(blocks, separatorFor(format))
    const start = decodeStart(options, format, version, blocks.length)
    const end = pageEnd(bounds, start)
    return {
      meta: await this.listItem(meta),
      content: blocksContent(format, selected, blocks, bounds, start, end),
      nextCursor: end < blocks.length ? encodeCursor(end, format, version, options) : null,
      inProgress: await this.isInProgress(meta, version),
      range: pageRange(blocks, start, end),
      totalSegments: entries.length
    }
  }

  /** Trechos já prontos, sem repetir nem pular enquanto o parcial cresce (spec §9.7). */
  async segmentsAfter(
    id: string,
    after: number
  ): Promise<{ segments: TranscriptEntry[]; next: number }> {
    const meta = await this.history.get(id)
    const entries = sortByStart(await this.history.readActive(meta))
    const start = Math.max(0, Math.floor(after))
    return { segments: entries.slice(start), next: entries.length }
  }

  async audio(id: string, track: AudioTrack): Promise<AudioResult> {
    const meta = await this.history.get(id)
    const path = await this.trackPath(meta, track)
    const info = await stat(path)
    return { path, mime: contentTypeFor(path), bytes: info.size, durationS: meta.duration }
  }

  /** `directory` tem que existir e ser absoluta; nunca sobrescreve (spec §9.5). */
  async export(
    id: string,
    format: ExportFormat,
    directory: string,
    version: ReadVersion = 'active'
  ): Promise<string> {
    if (!isAbsolute(directory)) {
      throw new AppError('INVALID_REQUEST', 'A pasta de destino precisa ser absoluta', directory)
    }
    const info = await stat(directory).catch(() => null)
    if (!info?.isDirectory()) {
      throw new AppError('INVALID_REQUEST', 'Pasta de destino inexistente', directory)
    }
    const meta = await this.history.get(id)
    const entries = await this.versionEntries(meta, version)
    const path = await uniquePath(directory, exportName(meta, format))
    await writeFileAtomic(path, exportContent(entries, format, this.labels))
    return path
  }

  private async listItem(meta: HistoryMeta): Promise<ListedTranscription> {
    const item: ListedTranscription = {
      id: meta.id,
      title: meta.fileName,
      createdAt: meta.createdAt,
      durationS: meta.duration,
      language: meta.languageDetected ?? meta.language,
      kind: meta.kind,
      status: meta.status,
      hasRedo: await this.history.hasRedo(meta),
      error: meta.error
    }
    if (meta.tracks !== undefined) item.tracks = meta.tracks
    if (meta.requestedBy !== undefined) item.requestedBy = meta.requestedBy
    return item
  }

  private async versionEntries(
    meta: HistoryMeta,
    version: ReadVersion
  ): Promise<TranscriptEntry[]> {
    if (version === 'active') return this.history.readActive(meta)
    if (meta.kind !== 'live') {
      throw new AppError('INVALID_REQUEST', 'Versão só existe para itens ao vivo', version)
    }
    return this.history.readVersion(meta, version)
  }

  private async isInProgress(meta: HistoryMeta, version: ReadVersion): Promise<boolean> {
    if (meta.status === 'queued' || meta.status === 'processing') return true
    return !(await pathExists(this.finalPath(meta, version)))
  }

  private finalPath(meta: HistoryMeta, version: ReadVersion): string {
    const paths = this.history.paths(meta.id)
    if (version === 'live') return paths.live
    if (version === 'redo') return paths.transcript
    return meta.kind === 'live' && meta.activeVersion !== 'redo' ? paths.live : paths.transcript
  }

  private async trackPath(meta: HistoryMeta, track: AudioTrack): Promise<string> {
    const paths = this.history.paths(meta.id)
    if (track === 'source') return sourcePath(meta)
    if (track !== 'mix' && meta.kind !== 'live') {
      throw new AppError('INVALID_REQUEST', 'Faixa só existe em sessões ao vivo', track)
    }
    const path = track === 'mix' ? paths.audio : join(paths.dir, `${track}.m4a`)
    if (!(await pathExists(path))) {
      throw new AppError('NOT_FOUND', 'Áudio ainda não foi gerado', path)
    }
    if (!(await isInside(path, paths.dir))) {
      throw new AppError('FILE_NOT_FOUND', 'Arquivo fora do histórico', path)
    }
    return path
  }
}

/** Filtros combinados de `list` (spec §9.1); `query` ignora maiúsculas e acentos. */
function matchesFilter(meta: HistoryMeta, filter: ListFilter): boolean {
  return matchesItem(meta, filter) && matchesStatus(meta, filter) && matchesQuery(meta, filter)
}

/** Filtros comuns a `list` e `search` (spec §9.1/§9.2): faixa de datas e tipo de item. */
function matchesItem(meta: HistoryMeta, filter: ItemFilter): boolean {
  return matchesKind(meta, filter) && matchesSince(meta, filter) && matchesUntil(meta, filter)
}

function matchesKind(meta: HistoryMeta, filter: ItemFilter): boolean {
  return filter.kind === undefined || meta.kind === filter.kind
}

function matchesStatus(meta: HistoryMeta, filter: ListFilter): boolean {
  return filter.status === undefined || meta.status === filter.status
}

function matchesQuery(meta: HistoryMeta, filter: ListFilter): boolean {
  return filter.query === undefined || fold(meta.fileName).text.includes(fold(filter.query).text)
}

function matchesSince(meta: HistoryMeta, filter: ItemFilter): boolean {
  return filter.since === undefined || Date.parse(meta.createdAt) >= Date.parse(filter.since)
}

function matchesUntil(meta: HistoryMeta, filter: ItemFilter): boolean {
  return filter.until === undefined || Date.parse(meta.createdAt) <= Date.parse(filter.until)
}

interface Folded {
  text: string
  map: number[]
}

const COMBINING = /[\u0300-\u036f]/g

/** Texto sem maiúsculas nem acentos, com o mapa de cada caractere de volta ao original. */
function fold(value: string): Folded {
  let text = ''
  const map: number[] = []
  for (let index = 0; index < value.length; index++) {
    const folded = value.charAt(index).toLowerCase().normalize('NFD').replace(COMBINING, '')
    for (const char of folded) {
      text += char
      map.push(index)
    }
  }
  return { text, map }
}

function sortByStart(entries: TranscriptEntry[]): TranscriptEntry[] {
  return [...entries].sort((a, b) => a.inicio - b.inicio)
}

function collectHits(
  meta: HistoryMeta,
  transcript: TranscriptEntry[],
  needle: string,
  hits: SearchHit[]
): void {
  for (const entry of transcript) {
    const hit = hitOf(meta, entry, needle)
    if (hit) hits.push(hit)
  }
}

function hitOf(meta: HistoryMeta, entry: TranscriptEntry, needle: string): SearchHit | null {
  const folded = fold(entry.texto)
  const at = folded.text.indexOf(needle)
  if (at < 0) return null
  // `fold` mapeia todo caractere normalizado, então os índices existem; `Number` evita asserts.
  const start = Number(folded.map[at])
  const last = Number(folded.map[at + needle.length - 1])
  const hit: SearchHit = {
    id: meta.id,
    title: meta.fileName,
    createdAt: meta.createdAt,
    start: entry.inicio,
    end: entry.fim,
    snippet: snippetOf(entry.texto, start, last + 1)
  }
  if (entry.falante !== undefined) hit.speaker = entry.falante
  return hit
}

function snippetOf(text: string, matchStart: number, matchEnd: number): string {
  const span = matchEnd - matchStart
  let start = matchStart - Math.floor((SNIPPET_CHARS - span) / 2)
  if (start < 0) start = 0
  let end = start + SNIPPET_CHARS
  if (end > text.length) {
    end = text.length
    start = Math.max(0, end - SNIPPET_CHARS)
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

interface Block {
  text: string
  start: number
  end: number
}

function buildBlocks(
  entries: TranscriptEntry[],
  format: ReadFormat,
  labels: SpeakerLabels
): Block[] {
  if (format === 'text') {
    return toParagraphs(entries).map((paragraph) => ({
      text: `${speakerPrefix(paragraph.falante, labels)}${paragraph.text}`,
      start: paragraph.start,
      end: paragraph.end
    }))
  }
  return entries.map((entry) => ({
    text: format === 'json' ? toJson([entry]) : toTimestamped([entry], labels),
    start: entry.inicio,
    end: entry.fim
  }))
}

function separatorFor(format: ReadFormat): string {
  return format === 'text' ? '\n\n' : ''
}

/** Acesso a `bounds` sabendo que todo índice usado existe (o `noUncheckedIndexedAccess` não sabe). */
function offset(bounds: number[], index: number): number {
  return Number(bounds[index])
}

/** Deslocamento de cada bloco dentro do texto completo, mais o fim do último. */
function blockBounds(blocks: Block[], separator: string): number[] {
  const bounds = [0]
  if (blocks.length === 0) return bounds
  for (const block of blocks) {
    bounds.push(offset(bounds, bounds.length - 1) + block.text.length + separator.length)
  }
  const last = bounds.length - 1
  bounds[last] = offset(bounds, last) - separator.length
  return bounds
}

function pageEnd(bounds: number[], start: number): number {
  const blockCount = bounds.length - 1
  if (start >= blockCount) return start
  let end = start + 1
  while (end < blockCount && offset(bounds, end + 1) - offset(bounds, start) <= PAGE_CHARS) end++
  return end
}

function blocksContent(
  format: ReadFormat,
  selected: TranscriptEntry[],
  blocks: Block[],
  bounds: number[],
  start: number,
  end: number
): string {
  if (format === 'json') return toJson(selected.slice(start, end))
  const whole = blocks.map((block) => block.text).join(separatorFor(format))
  return whole.slice(offset(bounds, start), offset(bounds, end))
}

function pageRange(
  blocks: Block[],
  start: number,
  end: number
): { fromS: number | null; toS: number | null } {
  const page = blocks.slice(start, end)
  const first = page.at(0)
  const last = page.at(-1)
  return {
    fromS: first === undefined ? null : first.start,
    toS: last === undefined ? null : last.end
  }
}

function validateRange(fromS?: number, toS?: number): void {
  assertBound(fromS, 'from_s')
  assertBound(toS, 'to_s')
  if (fromS !== undefined && toS !== undefined && fromS > toS) {
    throw new AppError('INVALID_REQUEST', 'from_s não pode ser maior que to_s')
  }
}

function assertBound(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new AppError('INVALID_REQUEST', `Valor inválido em ${field}`)
  }
}

function withinRange(entries: TranscriptEntry[], fromS?: number, toS?: number): TranscriptEntry[] {
  if (fromS === undefined && toS === undefined) return entries
  return entries.filter((entry) => {
    if (toS !== undefined && entry.inicio > toS) return false
    if (fromS !== undefined && entry.fim < fromS) return false
    return true
  })
}

function encodeCursor(
  index: number,
  format: ReadFormat,
  version: ReadVersion,
  options: ReadOptions
): string {
  const payload: CursorPayload = { i: index, f: format, v: version }
  if (options.fromS !== undefined) payload.a = options.fromS
  if (options.toS !== undefined) payload.b = options.toS
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function parseCursor(cursor: string): CursorPayload {
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AppError('INVALID_REQUEST', 'Cursor inválido')
  }
  const parsed = CursorPayloadSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('INVALID_REQUEST', 'Cursor inválido')
  return parsed.data
}

function decodeStart(
  options: ReadOptions,
  format: ReadFormat,
  version: ReadVersion,
  blockCount: number
): number {
  if (options.cursor === undefined) return 0
  const payload = parseCursor(options.cursor)
  const same =
    payload.f === format &&
    payload.v === version &&
    payload.a === options.fromS &&
    payload.b === options.toS
  if (!same) throw new AppError('INVALID_REQUEST', 'Cursor de outro formato, versão ou intervalo')
  if (payload.i > blockCount) throw new AppError('INVALID_REQUEST', 'Cursor fora do intervalo')
  return payload.i
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function exportName(meta: HistoryMeta, format: ExportFormat): string {
  const base = safeBaseName(meta.fileName)
  if (format === 'json') return `${base}.json`
  return format === 'timestamped' ? `${base} (tempos).txt` : `${base}.txt`
}

function safeBaseName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  return sanitizeFileName(withoutExtension).replace(/\.(txt|json)$/i, '')
}

function exportContent(
  entries: TranscriptEntry[],
  format: ExportFormat,
  labels: SpeakerLabels
): string {
  if (format === 'json') return toJson(entries)
  if (format === 'timestamped') return toTimestamped(entries, labels)
  return paragraphsToText(toParagraphs(entries), labels)
}

async function uniquePath(directory: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const base = name.slice(0, dot)
  const extension = name.slice(dot)
  let candidate = join(directory, name)
  let suffix = 2
  while (await pathExists(candidate)) {
    candidate = join(directory, `${base} (${suffix})${extension}`)
    suffix++
  }
  return candidate
}

async function sourcePath(meta: HistoryMeta): Promise<string> {
  if (meta.kind !== 'file') {
    throw new AppError('INVALID_REQUEST', 'Só arquivos têm mídia original', meta.id)
  }
  if (!(await pathExists(meta.sourcePath))) {
    throw new AppError('FILE_NOT_FOUND', 'Arquivo original não encontrado', meta.sourcePath)
  }
  return meta.sourcePath
}

async function isInside(path: string, directory: string): Promise<boolean> {
  const [real, realDirectory] = await Promise.all([realpath(path), realpath(directory)])
  return real.startsWith(`${realDirectory}${sep}`)
}
