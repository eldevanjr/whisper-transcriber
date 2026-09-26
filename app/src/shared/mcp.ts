import { z } from 'zod'
import { ERROR_CODES, type ErrorCode } from './errors'
import { PHASES } from './events'
import { TRACKS } from './settings'

/** Clientes com botão no menu, na ordem da tela (spec §11.3). */
export const MCP_CLIENT_IDS = [
  'claude-code',
  'claude-desktop',
  'codex',
  'opencode',
  'cursor',
  'vscode',
  'gemini-cli',
  'windsurf'
] as const
export type McpClientId = (typeof MCP_CLIENT_IDS)[number]

/** Refazer do ao vivo: qual faixa está sendo transcrita (uma depois da outra). */
export const TrackPassSchema = z.object({
  track: z.enum(TRACKS),
  index: z.number(),
  count: z.number()
})

/** Progresso de um item na fila (spec §7.4 / §9.6); `etaS` é nulo quando `speed` ≤ 0. */
export const JobProgressSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  phase: z.enum(PHASES),
  pct: z.number(),
  processedS: z.number(),
  totalS: z.number(),
  speed: z.number(),
  etaS: z.number().nullable(),
  pass: TrackPassSchema.optional(),
  requestedBy: z.string().optional()
})
export type JobProgress = z.infer<typeof JobProgressSchema>

/** Item da fila aguardando (spec §9.6). */
export const PendingJobSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  requestedBy: z.string().optional()
})

/** Sessão ao vivo em andamento (spec §7.4 / §9.6). */
export const LiveActivitySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  startedAt: z.string(),
  tracks: z.array(z.enum(TRACKS)).optional()
})

/** Retrato do que o app está fazendo, servido pela ponte e por `get_activity` (spec §9.6). */
export const ActivitySnapshotSchema = z.object({
  appRunning: z.boolean(),
  current: JobProgressSchema.nullable(),
  pending: z.array(PendingJobSchema),
  live: LiveActivitySchema.nullable()
})
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>

const rid = z.number().int()

/** Requisições da ponte, união discriminada por `type` (spec §7.3). */
export const BridgeRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), rid, token: z.string() }),
  z.object({ type: z.literal('ping'), rid }),
  z.object({ type: z.literal('activity'), rid }),
  z.object({ type: z.literal('status'), rid, id: z.uuid() }),
  z.object({ type: z.literal('transcribe'), rid, path: z.string().min(1), client: z.string() })
])
export type BridgeRequest = z.infer<typeof BridgeRequestSchema>

export const BridgeErrorSchema = z.object({
  code: z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  detail: z.string().optional()
})

/** Respostas da ponte, união discriminada por `type` (spec §7.3). */
export const BridgeResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ok'), rid, data: z.unknown() }),
  z.object({ type: z.literal('error'), rid, error: BridgeErrorSchema })
])
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>

/** Uma linha de `mcp/activity.jsonl` (spec §12); sem conteúdo de transcrição. */
export const McpActivityLineSchema = z.object({
  at: z.string(),
  client: z.string(),
  tool: z.string(),
  id: z.string().optional(),
  title: z.string().optional()
})
export type McpActivityLine = z.infer<typeof McpActivityLineSchema>
