import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { AppError } from '../../shared/errors'
import type { JobStatus, TranscriptEntry } from '../../shared/history'
import type { ActivitySnapshot, JobProgress, LiveActivity, PendingJob } from '../../shared/mcp'
import { mediaKindOf } from '../../shared/media'
import type { BridgePort } from './server'
import { runTool, success, type McpContext } from './tools-read'

/** Tempo máximo de espera do `transcribe_file` com `wait` (spec §9.8 / §15). */
export const TRANSCRIBE_WAIT_MS = 10 * 60 * 1000
const WAIT_POLL_MS = 1000

const FINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'done',
  'failed',
  'canceled',
  'interrupted'
])

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface ActivityToolOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface StalledItem {
  id: string
  title: string
  status: JobStatus
  requested_by: string | null
}

/** Ferramentas que dependem do app aberto (spec §9.6–9.8). */
export function registerActivityTools(
  server: McpServer,
  ctx: McpContext,
  bridge: BridgePort,
  options: ActivityToolOptions = {}
): void {
  server.registerTool(
    'get_activity',
    {
      description:
        'Show what Whisper Transcriber is doing: current queue job, pending items and live session.',
      inputSchema: z.object({})
    },
    () =>
      runTool(ctx, 'get_activity', undefined, async () => {
        const snapshot = await activityOrClosed(bridge)
        if (!snapshot?.appRunning) {
          const data = closedActivity(await stalledItems(ctx))
          return { result: success(data, activitySummary(false)) }
        }
        return { result: success(openActivity(snapshot), activitySummary(true)) }
      })
  )

  server.registerTool(
    'get_status',
    {
      description:
        'Get one transcription status and the segments transcribed since a previous call.',
      inputSchema: z.object({
        id: z.uuid(),
        after: z.number().int().min(0).optional()
      })
    },
    (args) =>
      runTool(ctx, 'get_status', args.id, async () => {
        const progress = await progressOrNull(bridge, args.id)
        const { segments, next } = await ctx.library.segmentsAfter(args.id, args.after ?? 0)
        const meta = await ctx.library.get(args.id)
        const data = statusOutput(meta.status, progress, segments, next)
        return {
          result: success(data, `Status: ${meta.status}.`),
          id: meta.id,
          title: meta.title
        }
      })
  )

  server.registerTool(
    'transcribe_file',
    {
      description:
        'Queue a local audio or video file for transcription, opening the app if it is closed.',
      inputSchema: z.object({
        path: z.string().min(1),
        wait: z.boolean().optional()
      })
    },
    (args, extra) =>
      runTool(ctx, 'transcribe_file', undefined, async () => {
        const path = await validateMediaPath(args.path)
        const outcome = await bridge.transcribe(path, ctx.clientName(), false)
        if (args.wait !== true) {
          const created = createdOutput(outcome)
          return { result: success(created, `Queued ${path}.`), id: outcome.id }
        }
        const result = await waitForItem(ctx, bridge, outcome, extra, options)
        return { result, id: outcome.id }
      })
  )
}

/** Caminho absoluto, com extensão de mídia e arquivo legível (spec §9.8 / §14). */
export async function validateMediaPath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new AppError('INVALID_REQUEST', 'The media path must be absolute', path)
  }
  if (mediaKindOf(path) === null) {
    throw new AppError('UNSUPPORTED_FILE', 'Unsupported media file extension', path)
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new AppError('FILE_NOT_FOUND', 'File not found or not readable', path)
  }
  return path
}

function openActivity(snapshot: ActivitySnapshot): Record<string, unknown> {
  return {
    app_running: true,
    current: snapshot.current === null ? null : currentOutput(snapshot.current),
    pending: snapshot.pending.map(pendingOutput),
    live: snapshot.live === null ? null : liveOutput(snapshot.live)
  }
}

function closedActivity(stalled: StalledItem[]): Record<string, unknown> {
  return {
    app_running: false,
    current: null,
    pending: [],
    live: null,
    stalled
  }
}

function currentOutput(progress: JobProgress): Record<string, unknown> {
  return {
    id: progress.id,
    title: progress.title,
    phase: progress.phase,
    pct: progress.pct,
    processed_s: progress.processedS,
    total_s: progress.totalS,
    speed: progress.speed,
    eta_s: progress.etaS,
    pass: progress.pass === undefined ? null : { ...progress.pass },
    requested_by: progress.requestedBy ?? null
  }
}

function pendingOutput(item: PendingJob): Record<string, unknown> {
  return { id: item.id, title: item.title, requested_by: item.requestedBy ?? null }
}

function liveOutput(live: LiveActivity): Record<string, unknown> {
  return {
    id: live.id,
    title: live.title,
    started_at: live.startedAt,
    tracks: live.tracks ?? []
  }
}

function statusOutput(
  status: JobStatus,
  progress: JobProgress | null,
  segments: TranscriptEntry[],
  next: number
): Record<string, unknown> {
  return {
    status,
    ...(progress === null
      ? {}
      : { phase: progress.phase, pct: progress.pct, eta_s: progress.etaS }),
    segments: segments.map(segmentOutput),
    next_after: next,
    done: FINAL_STATUSES.has(status)
  }
}

function segmentOutput(entry: TranscriptEntry): Record<string, unknown> {
  return {
    start: entry.inicio,
    end: entry.fim,
    text: entry.texto,
    ...(entry.falante === undefined ? {} : { speaker: entry.falante })
  }
}

function createdOutput(outcome: { id: string; position?: number }): Record<string, unknown> {
  return { id: outcome.id, status: 'queued', position: outcome.position ?? null }
}

/** Retrato do app; `null` quando a ponte está fora (app fechado), para cair no disco. */
async function activityOrClosed(bridge: BridgePort): Promise<ActivitySnapshot | null> {
  try {
    return await bridge.activity()
  } catch (error) {
    if (isUnavailable(error)) return null
    throw error
  }
}

/** Progresso do item; `null` quando o app está fechado (a leitura do disco continua). */
async function progressOrNull(bridge: BridgePort, id: string): Promise<JobProgress | null> {
  try {
    return await bridge.status(id)
  } catch (error) {
    if (isUnavailable(error)) return null
    throw error
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof AppError && error.code === 'WORKER_UNAVAILABLE'
}

async function stalledItems(ctx: McpContext): Promise<StalledItem[]> {
  const [queued, processing] = await Promise.all([
    ctx.library.list({ status: 'queued' }),
    ctx.library.list({ status: 'processing' })
  ])
  return [...queued.items, ...processing.items].map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    requested_by: item.requestedBy ?? null
  }))
}

async function waitForItem(
  ctx: McpContext,
  bridge: BridgePort,
  outcome: { id: string; position?: number },
  extra: ToolExtra,
  options: ActivityToolOptions
): Promise<CallToolResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? delay
  const deadline = now() + TRANSCRIBE_WAIT_MS
  for (;;) {
    const progress = await requiredProgress(bridge, outcome.id)
    if (progress === null) return progressResult(ctx, outcome.id)
    await notifyProgress(extra, progress)
    const final = finalResult(outcome.id, await ctx.library.get(outcome.id))
    if (final) return final
    if (now() >= deadline) return timeoutResult(outcome.id)
    await sleep(WAIT_POLL_MS)
  }
}

function finalResult(
  id: string,
  meta: { status: JobStatus; error: unknown }
): CallToolResult | null {
  if (!FINAL_STATUSES.has(meta.status)) return null
  const error = meta.error === null ? {} : { error: meta.error }
  return success(
    { id, status: meta.status, ...error },
    `Transcription finished with status ${meta.status}.`
  )
}

function timeoutResult(id: string): CallToolResult {
  return success(
    { id, status: 'queued', message: 'still running; use get_status' },
    `still running; use get_status with id ${id}.`
  )
}

async function requiredProgress(bridge: BridgePort, id: string): Promise<JobProgress | null> {
  try {
    return await bridge.status(id)
  } catch (error) {
    if (isUnavailable(error)) {
      throw new AppError(
        'WORKER_UNAVAILABLE',
        `Lost connection to the app; use get_status with id ${id}.`
      )
    }
    throw error
  }
}

async function progressResult(ctx: McpContext, id: string): Promise<CallToolResult> {
  const meta = await ctx.library.get(id)
  if (FINAL_STATUSES.has(meta.status)) {
    return success(
      { id, status: meta.status },
      `Transcription finished with status ${meta.status}.`
    )
  }
  return timeoutResult(id)
}

async function notifyProgress(extra: ToolExtra, progress: JobProgress): Promise<void> {
  const token = extra._meta?.progressToken
  if (token === undefined) return
  await extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken: token, progress: progress.pct, total: 100, message: progress.phase }
  })
}

function activitySummary(running: boolean): string {
  return running
    ? 'Whisper Transcriber is running; see current, pending and live.'
    : 'Whisper Transcriber is not running.'
}
