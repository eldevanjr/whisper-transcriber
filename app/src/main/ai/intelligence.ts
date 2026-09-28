import type {
  AiAnalysis,
  AiAnalysisItem,
  AiAnswer,
  AiAnswerSource,
  AiDiagnosticCheck,
  AiEntityKind,
  AiIndexProgress,
  AiStatus,
  AiStorageStatus
} from '../../shared/ipc'

/** Campo de texto e campo de detalhe de cada tipo de entidade do worker. */
const ENTITY_SPECS: readonly {
  kind: AiEntityKind
  key: string
  text: string
  details: readonly string[]
}[] = [
  { kind: 'topic', key: 'topics', text: 'name', details: ['description'] },
  { kind: 'task', key: 'tasks', text: 'description', details: ['assignee', 'deadline', 'status'] },
  { kind: 'decision', key: 'decisions', text: 'description', details: [] },
  { kind: 'problem', key: 'problems', text: 'description', details: ['severity'] },
  { kind: 'question', key: 'questions', text: 'question', details: [] },
  { kind: 'person', key: 'people', text: 'name', details: ['role'] }
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bounds(raw: Record<string, unknown>): { start: number | null; end: number | null } {
  const segments = raw.source_segments
  if (!Array.isArray(segments)) return { start: null, end: null }
  for (const segment of segments) {
    if (isRecord(segment) && typeof segment.start === 'number') {
      return {
        start: segment.start,
        end: typeof segment.end === 'number' ? segment.end : null
      }
    }
  }
  return { start: null, end: null }
}

function toItem(
  kind: AiEntityKind,
  text: string,
  details: readonly string[],
  raw: unknown
): AiAnalysisItem | null {
  if (!isRecord(raw)) return null
  const label = stringOf(raw[text])
  if (label === null) return null
  const detail = details
    .map((field) => stringOf(raw[field]))
    .filter((value): value is string => value !== null)
    .join(' · ')
  const { start, end } = bounds(raw)
  return {
    id: stringOf(raw.id) ?? `${kind}:${label}`,
    kind,
    text: label,
    detail: detail === '' ? null : detail,
    confidence: numberOr(raw.confidence, 0),
    state: stringOf(raw.state),
    start,
    end
  }
}

/** Normaliza o `AnalysisResult` do worker (JSON livre) para o formato da UI. */
export function normalizeAnalysis(raw: unknown): AiAnalysis {
  if (!isRecord(raw)) return { summary: null, items: [], model: null }
  const items: AiAnalysisItem[] = []
  for (const spec of ENTITY_SPECS) {
    const list = raw[spec.key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const item = toItem(spec.kind, spec.text, spec.details, entry)
      if (item !== null) items.push(item)
    }
  }
  return { summary: stringOf(raw.summary), items, model: stringOf(raw.model) }
}

function counts(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {}
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  return result
}

function indexProgress(raw: unknown): AiIndexProgress {
  const index = counts(raw)
  const total = Object.values(index).reduce((sum, value) => sum + value, 0)
  return {
    total,
    completed: index.COMPLETED ?? 0,
    pending: (index.PENDING ?? 0) + (index.PROCESSING ?? 0),
    failed: index.FAILED ?? 0
  }
}

function storageStatus(raw: unknown): AiStorageStatus | null {
  if (!isRecord(raw)) return null
  return {
    kind: stringOf(raw.kind) ?? 'sqlite',
    fallback: raw.fallback === true,
    reason: stringOf(raw.reason)
  }
}

/** Normaliza o `ai_status` do worker para a UI. */
export function normalizeStatus(raw: Record<string, unknown>): AiStatus {
  const analysis = counts(raw.analysis)
  return {
    configured: raw.configured === true,
    enabled: raw.enabled === true,
    pendingAnalysis: (analysis.PENDING ?? 0) + (analysis.PROCESSING ?? 0),
    failedAnalysis: analysis.FAILED ?? 0,
    index: indexProgress(raw.index),
    storage: storageStatus(raw.storage),
    blocked: stringOf(raw.blocked),
    reindexRequired: raw.reindex_required === true
  }
}

/** Normaliza o `ai_diagnose` do worker para a UI. */
export function normalizeDiagnostics(raw: Record<string, unknown>): AiDiagnosticCheck[] {
  const checks = raw.checks
  if (!Array.isArray(checks)) return []
  const result: AiDiagnosticCheck[] = []
  for (const check of checks) {
    if (!isRecord(check)) continue
    const name = stringOf(check.name)
    if (name === null) continue
    result.push({ name, ok: check.ok === true, detail: stringOf(check.detail) })
  }
  return result
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function answerSource(raw: unknown): AiAnswerSource | null {
  if (!isRecord(raw) || !isRecord(raw.chunk)) return null
  const metadata = isRecord(raw.chunk.metadata) ? raw.chunk.metadata : {}
  return {
    transcriptionId: stringOf(metadata.transcription_id),
    title: isRecord(raw.source) ? stringOf(raw.source.title) : null,
    text: stringOf(raw.chunk.content) ?? '',
    start: numberOrNull(metadata.start_time),
    end: numberOrNull(metadata.end_time)
  }
}

/** Normaliza a resposta do RAG (`knowledge_ask`) com as fontes para a UI. */
export function normalizeAnswer(raw: Record<string, unknown>): AiAnswer {
  const sources = Array.isArray(raw.sources) ? raw.sources : []
  return {
    answer: stringOf(raw.answer) ?? '',
    model: stringOf(raw.model),
    sources: sources.map(answerSource).filter((source): source is AiAnswerSource => source !== null)
  }
}

/**
 * O processo da IA não carrega o Whisper: o estado do motor de transcrição vem do
 * app (modelo escolhido nas configurações).
 */
export function withWhisperCheck(
  checks: AiDiagnosticCheck[],
  model: string | null
): AiDiagnosticCheck[] {
  const whisper: AiDiagnosticCheck =
    model === null
      ? { name: 'whisper', ok: false, detail: 'nenhum modelo escolhido' }
      : { name: 'whisper', ok: true, detail: model }
  return [whisper, ...checks.filter((check) => check.name !== 'whisper')]
}
