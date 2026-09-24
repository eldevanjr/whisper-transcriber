import { z } from 'zod'
import { AppError, isErrorCode } from '../../shared/errors'
import { PHASES } from '../../shared/events'
import type { Device } from '../../shared/settings'

export const PROTOCOL_VERSION = 2

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

export const WorkerEventSchema = z.discriminatedUnion('type', [
  ready,
  heartbeat,
  result,
  error,
  phase,
  progress,
  segment,
  done
])
export type WorkerEvent = z.infer<typeof WorkerEventSchema>
export type JobEvent = Extract<WorkerEvent, { type: 'phase' | 'progress' | 'segment' | 'done' }>
export type WorkerErrorEvent = Extract<WorkerEvent, { type: 'error' }>

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
