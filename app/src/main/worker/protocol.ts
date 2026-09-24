import { z } from 'zod'
import { AppError, isErrorCode } from '../../shared/errors'
import { PHASES } from '../../shared/events'
import { TRACKS, type Device, type Track } from '../../shared/settings'

export const PROTOCOL_VERSION = 3

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
  liveError
])
export type WorkerEvent = z.infer<typeof WorkerEventSchema>
export type JobEvent = Extract<WorkerEvent, { type: 'phase' | 'progress' | 'segment' | 'done' }>
export type WorkerErrorEvent = Extract<WorkerEvent, { type: 'error' }>
export type LiveWorkerEvent = Extract<
  WorkerEvent,
  { type: 'live_segment' | 'live_listening' | 'live_lag' | 'live_error' }
>

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
