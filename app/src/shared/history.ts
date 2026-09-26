import { z } from 'zod'
import { TRACKS, type Track } from './settings'
import { ERROR_CODES, type ErrorCode } from './errors'
import { MODEL_IDS } from './models'

export const JOB_STATUSES = [
  'queued',
  'processing',
  'done',
  'failed',
  'canceled',
  'interrupted'
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const ErrorInfoSchema = z.object({
  code: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  detail: z.string().optional()
})

export const HistoryMetaSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  sourcePath: z.string(),
  mediaKind: z.enum(['video', 'audio']),
  createdAt: z.string(),
  status: z.enum(JOB_STATUSES),
  model: z.enum(MODEL_IDS),
  language: z.string().nullable(),
  languageDetected: z.string().nullable(),
  duration: z.number().nullable(),
  error: ErrorInfoSchema.nullable(),
  // Transcrição ao vivo: faixas gravadas e qual versão aparece (ao vivo ou refeita).
  kind: z.enum(['file', 'live']).default('file'),
  tracks: z.array(z.enum(TRACKS)).optional(),
  activeVersion: z.enum(['live', 'redo']).optional(),
  // Cliente MCP que pediu a transcrição (id normalizado, §11.3); ausente = pedido pelo app.
  requestedBy: z.string().optional()
})
export type HistoryMeta = z.infer<typeof HistoryMetaSchema>

export interface Segment {
  start: number
  end: number
  text: string
  speaker?: Track // ao vivo: quem falou
}

export const TranscriptEntrySchema = z.object({
  inicio: z.number(),
  fim: z.number(),
  texto: z.string(),
  falante: z.enum(TRACKS).optional()
})
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>

const round3 = (value: number): number => Math.round(value * 1000) / 1000

export function toTranscriptEntry(segment: Segment): TranscriptEntry {
  const entry: TranscriptEntry = {
    inicio: round3(segment.start),
    fim: round3(segment.end),
    texto: segment.text
  }
  if (segment.speaker) entry.falante = segment.speaker
  return entry
}

export const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value)
}

export interface HistoryList {
  entries: HistoryMeta[]
  corrupted: string[]
}

export interface StorageStats {
  count: number
  bytes: number
}
