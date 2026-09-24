import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../../shared/errors'
import {
  HistoryMetaSchema,
  isJobId,
  toTranscriptEntry,
  TranscriptEntrySchema,
  type HistoryList,
  type HistoryMeta,
  type Segment,
  type StorageStats,
  type TranscriptEntry
} from '../../shared/history'
import { fileNameOf, type MediaKind } from '../../shared/media'
import type { ModelId } from '../../shared/models'
import type { Track } from '../../shared/settings'
import { dirSize, isNotFound, pathExists, readJson, writeJsonAtomic } from '../fs-utils'

export interface JobPaths {
  dir: string
  meta: string
  transcript: string
  partial: string
  audio: string
  live: string // ao vivo: a transcrição feita na hora, guardada quando houver a refeita
}

export interface NewJob {
  sourcePath: string
  mediaKind: MediaKind
  model: ModelId
  language: string | null
}

export interface NewLiveSession {
  title: string
  tracks: Track[]
  model: ModelId
  language: string | null
}

const TranscriptSchema = TranscriptEntrySchema.array()

export class HistoryStore {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  paths(id: string): JobPaths {
    if (!isJobId(id)) throw new AppError('INVALID_REQUEST', 'Identificador inválido')
    const dir = join(this.root, id)
    return {
      dir,
      meta: join(dir, 'meta.json'),
      transcript: join(dir, 'transcript.json'),
      partial: join(dir, 'transcript.partial.jsonl'),
      audio: join(dir, 'audio.m4a'),
      live: join(dir, 'transcript-live.json')
    }
  }

  async create(job: NewJob): Promise<HistoryMeta> {
    const meta: HistoryMeta = {
      id: this.newId(),
      fileName: fileNameOf(job.sourcePath),
      sourcePath: job.sourcePath,
      mediaKind: job.mediaKind,
      createdAt: this.now().toISOString(),
      status: 'queued',
      model: job.model,
      language: job.language,
      languageDetected: null,
      duration: null,
      error: null,
      kind: 'file'
    }
    await writeJsonAtomic(this.paths(meta.id).meta, meta)
    return meta
  }

  /** Sessão ao vivo: começa em processamento (a gravação e os trechos vêm enquanto dura). */
  async createLive(session: NewLiveSession): Promise<HistoryMeta> {
    const meta: HistoryMeta = {
      id: this.newId(),
      fileName: session.title,
      sourcePath: '',
      mediaKind: 'audio',
      createdAt: this.now().toISOString(),
      status: 'processing',
      model: session.model,
      language: session.language,
      languageDetected: null,
      duration: null,
      error: null,
      kind: 'live',
      tracks: session.tracks,
      activeVersion: 'live'
    }
    await writeJsonAtomic(this.paths(meta.id).meta, meta)
    return meta
  }

  async get(id: string): Promise<HistoryMeta> {
    const { meta } = this.paths(id)
    let raw: unknown
    try {
      raw = await readJson(meta)
    } catch (error) {
      if (isNotFound(error)) throw new AppError('NOT_FOUND', 'Transcrição não encontrada', id)
      throw new AppError('INTERNAL', 'Histórico corrompido', id)
    }
    const parsed = HistoryMetaSchema.safeParse(raw)
    if (!parsed.success) throw new AppError('INTERNAL', 'Histórico corrompido', id)
    return parsed.data
  }

  async update(id: string, patch: Partial<Omit<HistoryMeta, 'id'>>): Promise<HistoryMeta> {
    const next = HistoryMetaSchema.parse({ ...(await this.get(id)), ...patch })
    await writeJsonAtomic(this.paths(id).meta, next)
    return next
  }

  async list(): Promise<HistoryList> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return { entries: [], corrupted: [] }
    }
    const entries: HistoryMeta[] = []
    const corrupted: string[] = []
    for (const name of names.filter(isJobId)) {
      try {
        entries.push(await this.get(name))
      } catch {
        corrupted.push(name)
      }
    }
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return { entries, corrupted }
  }

  async appendSegment(id: string, segment: Segment): Promise<void> {
    await appendFile(this.paths(id).partial, `${JSON.stringify(segment)}\n`, 'utf8')
  }

  async finalize(id: string): Promise<TranscriptEntry[]> {
    return this.finalizeTo(id, this.paths(id).transcript)
  }

  /** Ao vivo: só a versão ao vivo; `transcript.json` passa a existir quando houver a refeita. */
  async finalizeLive(id: string): Promise<TranscriptEntry[]> {
    return this.finalizeTo(id, this.paths(id).live)
  }

  private async finalizeTo(id: string, target: string): Promise<TranscriptEntry[]> {
    const { partial } = this.paths(id)
    // Refazer do ao vivo grava uma faixa depois da outra: aqui elas se intercalam por início.
    const segments = (await readSegments(partial)).sort((a, b) => a.start - b.start)
    const entries = segments.map(toTranscriptEntry)
    await writeJsonAtomic(target, entries)
    await rm(partial, { force: true })
    return entries
  }

  /** A versão que o item mostra: a refeita ou a ao vivo (itens ao vivo); a de sempre (arquivos). */
  async readActive(meta: HistoryMeta): Promise<TranscriptEntry[]> {
    const { live, transcript } = this.paths(meta.id)
    const path = meta.kind === 'live' && meta.activeVersion !== 'redo' ? live : transcript
    return this.readOrPartial(path, meta.id)
  }

  /**
   * Antes de refazer um item ao vivo: as faixas precisam estar convertidas (m4a) e a versão ao
   * vivo guardada, porque o refazer usa o parcial para a versão nova.
   */
  async prepareRedo(meta: HistoryMeta): Promise<void> {
    const { dir, live } = this.paths(meta.id)
    for (const track of meta.tracks ?? []) {
      if (!(await pathExists(join(dir, `${track}.m4a`)))) {
        throw new AppError('FILE_NOT_FOUND', 'A gravação desta sessão não está pronta', track)
      }
    }
    if (!(await pathExists(live))) await this.finalizeLive(meta.id)
  }

  async hasRedo(meta: HistoryMeta): Promise<boolean> {
    return meta.kind === 'live' && (await pathExists(this.paths(meta.id).transcript))
  }

  /** Sem transcript.json (job em andamento ou interrompido), devolve o que já está no parcial. */
  async readTranscript(id: string): Promise<TranscriptEntry[]> {
    return this.readOrPartial(this.paths(id).transcript, id)
  }

  private async readOrPartial(path: string, id: string): Promise<TranscriptEntry[]> {
    const { partial } = this.paths(id)
    try {
      return await readEntries(path, id)
    } catch (error) {
      if (isNotFound(error)) return (await readSegments(partial)).map(toTranscriptEntry)
      throw error
    }
  }

  /** Só o texto parcial: o áudio extraído fica para reaproveitar ao refazer (cancelou, falhou). */
  async discardPartial(id: string): Promise<void> {
    await rm(this.paths(id).partial, { force: true })
  }

  async discardOutputs(id: string): Promise<void> {
    const { partial, audio } = this.paths(id)
    await Promise.all([rm(partial, { force: true }), rm(audio, { force: true })])
  }

  async remove(id: string): Promise<void> {
    await rm(this.paths(id).dir, { recursive: true, force: true })
  }

  async stats(): Promise<StorageStats> {
    const { entries, corrupted } = await this.list()
    return { count: entries.length + corrupted.length, bytes: await dirSize(this.root) }
  }

  async clear(): Promise<StorageStats> {
    const stats = await this.stats()
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true })
    return stats
  }
}

/** JSON da transcrição validado; arquivo ausente propaga o ENOENT, o resto vira INTERNAL. */
async function readEntries(path: string, id: string): Promise<TranscriptEntry[]> {
  let raw: unknown
  try {
    raw = await readJson(path)
  } catch (error) {
    if (isNotFound(error)) throw error
    throw new AppError('INTERNAL', 'Transcrição corrompida', id)
  }
  const parsed = TranscriptSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('INTERNAL', 'Transcrição corrompida', id)
  return parsed.data
}

async function readSegments(path: string): Promise<Segment[]> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const segments: Segment[] = []
  for (const line of content.split('\n')) {
    try {
      segments.push(JSON.parse(line) as Segment)
    } catch {
      // linha vazia ou cortada (app fechado no meio da escrita): descartada
    }
  }
  return segments
}
