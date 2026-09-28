import type { SearchResult } from 'ai-core-types'
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

/** Nome amigável de cada cliente MCP (spec §11.3); marcas, então não se traduzem. */
export const MCP_CLIENT_NAMES: Record<McpClientId, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  vscode: 'VS Code',
  'gemini-cli': 'Gemini CLI',
  windsurf: 'Windsurf'
}

const MCP_CLIENT_NAME_BY_ID = new Map<string, string>(Object.entries(MCP_CLIENT_NAMES))

/** Tamanho máximo do nome cru guardado nos registros (spec §11.3). */
const CLIENT_NAME_MAX = 40

/**
 * Correspondência de trecho, sem maiúsculas, do `clientInfo.name` para o id do cliente
 * (spec §11.3). A ordem importa onde um trecho contém outro.
 */
const MCP_CLIENT_ID_MATCHERS: readonly (readonly [string, McpClientId])[] = [
  ['claude-code', 'claude-code'],
  ['claude-ai', 'claude-desktop'],
  ['codex', 'codex'],
  ['opencode', 'opencode'],
  ['cursor', 'cursor'],
  ['visual studio code', 'vscode'],
  ['vscode', 'vscode'],
  ['gemini', 'gemini-cli'],
  ['windsurf', 'windsurf']
]

/** Normaliza o `clientInfo.name` do handshake para o id do cliente (spec §11.3). */
export function clientIdOf(name: string): string {
  const lower = name.toLowerCase()
  const match = MCP_CLIENT_ID_MATCHERS.find(([needle]) => lower.includes(needle))
  return match === undefined ? name.slice(0, CLIENT_NAME_MAX) : match[1]
}

/** Nome de exibição do cliente pelo id ou nome do handshake; desconhecido volta como veio. */
export function clientDisplayName(id: string): string {
  const normalized = clientIdOf(id)
  return MCP_CLIENT_NAME_BY_ID.get(normalized) ?? normalized
}

/** Três estados de um cliente no menu (spec §11.1). */
export type ClientState = 'missing' | 'found' | 'connected'

/** Erro/aviso mostrado no cartão; `code` ausente é um alerta (ex.: config antiga). */
export interface ClientStatusError {
  code?: ErrorCode
  message: string
  detail?: string
}

/** Config manual pronta de um cliente (spec §11.2), mostrada no cartão com "Copiar". */
export interface McpManualConfig {
  kind: 'command' | 'json' | 'toml'
  text: string
}

/** Retrato de um cliente para a tela (spec §10.2). */
export interface ClientStatus {
  id: McpClientId
  name: string
  state: ClientState
  lastUsedAt: string | null
  restartNeeded: boolean
  manual: McpManualConfig
  error?: ClientStatusError
}

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
export type PendingJob = z.infer<typeof PendingJobSchema>

/** Sessão ao vivo em andamento (spec §7.4 / §9.6). */
export const LiveActivitySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  startedAt: z.string(),
  tracks: z.array(z.enum(TRACKS)).optional()
})
export type LiveActivity = z.infer<typeof LiveActivitySchema>

/** Retrato do que o app está fazendo, servido pela ponte e por `get_activity` (spec §9.6). */
export const ActivitySnapshotSchema = z.object({
  appRunning: z.boolean(),
  current: JobProgressSchema.nullable(),
  pending: z.array(PendingJobSchema),
  live: LiveActivitySchema.nullable()
})
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>

const rid = z.number().int()

/** Tipos de entidade detectados pela análise e pesquisáveis pelos MCP. */
export const KNOWLEDGE_ENTITY_KINDS = [
  'topic',
  'task',
  'decision',
  'problem',
  'question',
  'person'
] as const
export type KnowledgeEntityKind = (typeof KNOWLEDGE_ENTITY_KINDS)[number]

/** Resposta fundamentada da IA local, com as fontes usadas (plano §21). */
export interface KnowledgeAnswer {
  answer: string
  model: string | null
  sources: SearchResult[]
}

/**
 * Contratos de conhecimento da IA local compartilhados entre a ponte MCP e o cliente
 * (evita duplicar os modelos — plano §22 / CA-17).
 */
export interface KnowledgePort {
  knowledge(query: string, limit: number): Promise<SearchResult[]>
  ask(question: string, limit: number): Promise<KnowledgeAnswer>
  entities(kind: KnowledgeEntityKind, query: string | undefined, limit: number): Promise<unknown[]>
  analysis(transcriptionId: string): Promise<unknown>
}

/** Requisições da ponte, união discriminada por `type` (spec §7.3). */
export const BridgeRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), rid, token: z.string() }),
  z.object({ type: z.literal('ping'), rid }),
  z.object({ type: z.literal('activity'), rid }),
  z.object({ type: z.literal('status'), rid, id: z.uuid() }),
  z.object({ type: z.literal('transcribe'), rid, path: z.string().min(1), client: z.string() }),
  z.object({
    type: z.literal('knowledge'),
    rid,
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(50)
  }),
  z.object({
    type: z.literal('entities'),
    rid,
    kind: z.enum(KNOWLEDGE_ENTITY_KINDS),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100)
  }),
  z.object({
    type: z.literal('ask'),
    rid,
    question: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20)
  }),
  z.object({ type: z.literal('analysis'), rid, transcriptionId: z.uuid() })
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
