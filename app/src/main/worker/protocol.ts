import { z } from 'zod'
import { AppError, isErrorCode } from '../../shared/errors'
import { PHASES } from '../../shared/events'
import { TRACKS, type Device, type Track } from '../../shared/settings'

export const PROTOCOL_VERSION = 4

const ready = z.object({ type: z.literal('ready'), protocol: z.number(), version: z.string() })
const heartbeat = z.object({ type: z.literal('heartbeat') })
const result = z.object({
  type: z.literal('result'),
  id: z.string(),
  data: z.record(z.string(), z.unknown())
})
const error = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  id: z.string().optional(),
  job_id: z.string().optional(),
  detail: z.string().optional()
})
const phase = z.object({
  type: z.literal('phase'),
  phase: z.enum(PHASES),
  job_id: z.string().nullable()
})
const progress = z.object({
  type: z.literal('progress'),
  job_id: z.string(),
  pct: z.number(),
  processed_s: z.number(),
  total_s: z.number(),
  speed: z.number()
})
const segment = z.object({
  type: z.literal('segment'),
  job_id: z.string(),
  index: z.number().int(),
  start: z.number(),
  end: z.number(),
  text: z.string()
})
const done = z.object({
  type: z.literal('done'),
  job_id: z.string(),
  duration: z.number(),
  language_detected: z.string().nullable()
})

const track = z.enum(TRACKS)
const liveSegment = z.object({
  type: z.literal('live_segment'),
  session_id: z.string(),
  track,
  start: z.number(),
  end: z.number(),
  text: z.string()
})
const liveListening = z.object({
  type: z.literal('live_listening'),
  session_id: z.string(),
  track,
  active: z.boolean()
})
const liveLag = z.object({
  type: z.literal('live_lag'),
  session_id: z.string(),
  seconds: z.number()
})
const liveError = z.object({
  type: z.literal('live_error'),
  session_id: z.string(),
  code: z.string()
})

const aiStatus = z.object({
  type: z.literal('ai_status'),
  status: z.record(z.string(), z.unknown())
})
const aiAnalysis = z.object({
  type: z.literal('ai_analysis'),
  transcription_id: z.string(),
  result: z.unknown(),
  // parcial (janelas até agora) ou final (revisada com a transcrição inteira)
  final: z.boolean().default(false)
})
const aiSearch = z.object({
  type: z.literal('ai_search'),
  results: z.array(z.unknown())
})
const aiPull = z.object({
  type: z.literal('ai_pull'),
  model: z.string(),
  status: z.string().nullable(),
  completed: z.number(),
  total: z.number()
})

export const WorkerEventSchema = z.discriminatedUnion('type', [
  ready,
  heartbeat,
  result,
  error,
  phase,
  progress,
  segment,
  done,
  liveSegment,
  liveListening,
  liveLag,
  liveError,
  aiStatus,
  aiAnalysis,
  aiSearch,
  aiPull
])
export type WorkerEvent = z.infer<typeof WorkerEventSchema>
export type JobEvent = Extract<WorkerEvent, { type: 'phase' | 'progress' | 'segment' | 'done' }>
export type WorkerErrorEvent = Extract<WorkerEvent, { type: 'error' }>
export type LiveWorkerEvent = Extract<
  WorkerEvent,
  { type: 'live_segment' | 'live_listening' | 'live_lag' | 'live_error' }
>
export type AiWorkerEvent = Extract<
  WorkerEvent,
  { type: 'ai_status' | 'ai_analysis' | 'ai_search' | 'ai_pull' }
>

export type AiEntityKind = 'topic' | 'task' | 'decision' | 'problem' | 'question' | 'person'

export interface AiSegmentInput {
  index: number
  start: number
  end: number
  text: string
}

export interface ConfigureAiStorageParams {
  mode: 'fallback' | 'external' | 'local' | 'auto'
  postgres?: {
    host: string
    port: number
    database: string
    username: string
    password: string
    ssl_mode: string
    connect_timeout: number
  }
  volume?: string
  password?: string
  image?: string
}

export interface ConfigureAiParams {
  enabled: boolean
  ollama_url: string
  llm_model: string
  embedding_model: string
  incremental_analysis_enabled: boolean
  final_analysis_enabled: boolean
  analysis_window_seconds: number
  analysis_overlap_seconds: number
  max_concurrent_analysis: number
  prompt_version: string
  request_timeout_seconds: number
  allow_remote_ollama: boolean
  database_path: string
  storage: ConfigureAiStorageParams
}

export type WorkerCommand =
  | {
      cmd: 'load_model'
      params: {
        model_dir: string
        device: Device
        // cuda → faster-whisper (CTranslate2); gpu → whisper.cpp (Vulkan/Metal).
        engine: 'faster-whisper' | 'whisper-cpp'
        compute_type?: 'int8' | 'float16'
        cuda_lib_dir?: string
      }
    }
  | {
      cmd: 'transcribe'
      params: {
        job_id: string
        input_path: string
        language: string | null
        audio_out_path: string
      }
    }
  | { cmd: 'self_test' }
  | { cmd: 'shutdown' }
  | {
      cmd: 'live_start'
      params: {
        session_id: string
        tracks: Track[]
        language: string | null
        pause_s: number
        test?: boolean
      }
    }
  | {
      cmd: 'live_audio'
      params: { session_id: string; track: Track; seq: number; pcm16_b64: string }
    }
  | { cmd: 'live_stop'; params: { session_id: string } }
  | { cmd: 'live_pause'; params: { session_id: string } }
  | { cmd: 'live_finalize'; params: { dir: string; tracks: Track[] } }
  | { cmd: 'configure_ai'; params: ConfigureAiParams }
  | {
      cmd: 'analysis_submit'
      params: {
        transcription_id: string
        workspace_id: string
        title: string
        segments: AiSegmentInput[]
      }
    }
  | {
      cmd: 'analysis_append'
      params: {
        transcription_id: string
        workspace_id: string
        title: string
        segments: AiSegmentInput[]
      }
    }
  | { cmd: 'analysis_retry'; params: { transcription_id?: string } }
  | { cmd: 'analysis_process'; params: { max_items: number } }
  | { cmd: 'analysis_finalize'; params: { transcription_id: string; workspace_id: string } }
  | { cmd: 'analysis_get'; params: { workspace_id: string; transcription_id: string } }
  | { cmd: 'knowledge_search'; params: { workspace_id: string; query: string; limit: number } }
  | {
      cmd: 'knowledge_ask'
      params: { workspace_id: string; question: string; limit: number }
    }
  | {
      cmd: 'knowledge_search_entities'
      params: { workspace_id: string; kind: AiEntityKind; query?: string; limit: number }
    }
  | { cmd: 'knowledge_reindex'; params: { workspace_id: string } }
  | { cmd: 'knowledge_reindex_cancel'; params: { workspace_id: string } }
  | {
      cmd: 'knowledge_delete'
      params: { workspace_id: string; transcription_id: string }
    }
  | { cmd: 'knowledge_backup'; params: { workspace_id: string; path: string } }
  | { cmd: 'knowledge_restore'; params: { path: string; workspace_id?: string } }
  | { cmd: 'ai_status'; params?: { workspace_id?: string } }
  | { cmd: 'ai_diagnose' }
  | { cmd: 'ai_pull_model'; params: { model: string } }

export function parseWorkerEvent(line: string): WorkerEvent | null {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = WorkerEventSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

export function serializeCommand(id: string, command: WorkerCommand): string {
  return `${JSON.stringify({ id, ...command })}\n`
}

export function errorFromEvent(event: WorkerErrorEvent): AppError {
  return new AppError(
    isErrorCode(event.code) ? event.code : 'INTERNAL',
    event.message,
    event.detail
  )
}

export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const end = this.buffer.lastIndexOf('\n')
    if (end < 0) return []
    const complete = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end + 1)
    return complete
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim() !== '')
  }
}
