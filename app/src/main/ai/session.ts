import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { SearchResult } from 'ai-core-types'
import { toAppError } from '../../shared/errors'
import type { AiKnowledgeBackup, AiPulledModel, AiSecretKind } from '../../shared/ipc'
import type { AiReindexProgress } from '../../shared/events'
import type { KnowledgeAnswer } from '../../shared/mcp'
import type { AiSettings, AiStorage, Settings } from '../../shared/settings'
import {
  type AiEntityKind,
  type AiSegmentInput,
  type ConfigureAiParams,
  type ConfigureAiStorageParams,
  type WorkerCommand
} from '../worker/protocol'
import type { Logger, WorkerPort } from '../worker/supervisor'

/** Limite de uma linha do protocolo no worker (`MAX_LINE_LENGTH`, 64 KB). */
export const MAX_WORKER_LINE_BYTES = 64 * 1024
// Folga para id, comando e os outros parâmetros da linha.
const BATCH_BYTES = MAX_WORKER_LINE_BYTES - 8 * 1024

/** Divide os trechos em lotes que, serializados, cabem numa linha do protocolo. */
export function segmentBatches(segments: AiSegmentInput[]): AiSegmentInput[][] {
  const batches: AiSegmentInput[][] = []
  let current: AiSegmentInput[] = []
  let size = 0
  for (const segment of segments) {
    const bytes = Buffer.byteLength(JSON.stringify(segment)) + 1
    if (current.length > 0 && size + bytes > BATCH_BYTES) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(segment)
    size += bytes
  }
  batches.push(current)
  return batches
}

/** Volume do PostgreSQL do app quando o usuário não escolhe outro (modo local/automático). */
export const DEFAULT_CONTAINER_VOLUME = 'whisper-transcriber-pgdata'
const REINDEX_POLL_MS = 1000

/** Dependências da sessão de IA (tudo injetável para os testes). */
export interface AiSessionDeps {
  /** O processo da IA (separado do que transcreve). */
  worker: WorkerPort
  settings: { get(): Settings }
  /** Senhas vêm do cofre do sistema, nunca das settings. */
  secrets: AiSecrets
  databasePath: string
  logger: Logger
  /** Já existe conhecimento salvo (a IA pode ter sido desligada depois). */
  hasData?: () => boolean
  sleep?: (ms: number) => Promise<unknown>
  randomSecret?: () => string
}

/** Segredos guardados pelo main (cofre do sistema). */
export interface AiSecrets {
  get(kind: AiSecretKind): string | null
  /** Criptografia do sistema disponível (sem ela, nada é gravado em disco). */
  available(): boolean
  set(kind: AiSecretKind, value: string): Promise<unknown>
}

export interface AiSubmitInput {
  transcriptionId: string
  title: string
  segments: AiSegmentInput[]
  workspaceId?: string
}

function generateSecret(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Sessão de IA local do app: configura o worker da IA sob demanda e expõe
 * análise, indexação e busca. O worker guarda o runtime em memória; quando ele
 * reinicia (`reset()`, chamado pelo supervisor) ou responde AI_NOT_CONFIGURED,
 * a sessão reconfigura e repete o comando.
 */
export class AiSession {
  private configured: string | null = null
  private readonly reindexState = { canceled: false }
  private readonly sleep: (ms: number) => Promise<unknown>

  constructor(private readonly deps: AiSessionDeps) {
    this.sleep = deps.sleep ?? delay
  }

  /** Configura o runtime no worker (idempotente enquanto settings e senhas não mudam). */
  async configure(): Promise<void> {
    const ai = this.deps.settings.get().ai
    await this.ensureContainerSecret(ai.storage)
    const key = this.configurationKey(ai)
    if (this.configured === key) return
    await this.deps.worker.request({
      cmd: 'configure_ai',
      params: toConfigureParams(ai, this.deps.databasePath, this.deps.secrets)
    })
    this.configured = key
    this.deps.logger.info('[ia] runtime configurado')
  }

  /** Esquece a configuração (o processo da IA reiniciou e perdeu o runtime). */
  reset(): void {
    this.configured = null
  }

  private configurationKey(ai: AiSettings): string {
    // As senhas entram só como hash: trocar a senha reconfigura sem guardá-la aqui.
    const secrets = createHash('sha256')
      .update(
        `${this.deps.secrets.get('postgres') ?? ''}\n${this.deps.secrets.get('container') ?? ''}`
      )
      .digest('hex')
    return `${JSON.stringify(ai)}|${secrets}`
  }

  /** Modo local/automático: a senha do container é gerada uma vez e fica no cofre. */
  private async ensureContainerSecret(storage: AiStorage): Promise<void> {
    if (storage.mode !== 'local' && storage.mode !== 'auto') return
    if (this.deps.secrets.get('container') !== null) return
    // Sem cofre a senha não sobreviveria ao fechar o app, e o volume já criado não abriria.
    if (!this.deps.secrets.available()) return
    await this.deps.secrets.set('container', (this.deps.randomSecret ?? generateSecret)())
  }

  /** Configura e envia; worker reiniciado no meio do caminho: reconfigura e repete uma vez. */
  private async call(command: WorkerCommand): Promise<Record<string, unknown>> {
    await this.configure()
    try {
      return await this.deps.worker.request(command)
    } catch (error) {
      if (toAppError(error).code !== 'AI_NOT_CONFIGURED') throw error
      this.reset()
      await this.configure()
      return this.deps.worker.request(command)
    }
  }

  private enabled(): boolean {
    return this.deps.settings.get().ai.enabled
  }

  /** Leituras: com a IA desligada, só vale subir o worker se já houver conhecimento salvo. */
  private readable(): boolean {
    return this.enabled() || (this.deps.hasData?.() ?? false)
  }

  /**
   * Transcrição concluída: fecha a análise e indexa (refazer substitui o anterior).
   * Transcrição longa vai em lotes (`analysis_append`) e fecha com o último.
   */
  async submit(input: AiSubmitInput): Promise<void> {
    if (!this.enabled() || input.segments.length === 0) return
    const batches = segmentBatches(input.segments)
    for (const [position, segments] of batches.entries()) {
      const params = this.analysisParams({ ...input, segments })
      await this.call(
        position === batches.length - 1
          ? { cmd: 'analysis_submit', params }
          : { cmd: 'analysis_append', params }
      )
    }
  }

  /** Trechos novos de uma transcrição em andamento: a análise acompanha. */
  async append(input: AiSubmitInput): Promise<void> {
    if (!this.enabled() || input.segments.length === 0) return
    for (const segments of segmentBatches(input.segments)) {
      await this.call({
        cmd: 'analysis_append',
        params: this.analysisParams({ ...input, segments })
      })
    }
  }

  private analysisParams(input: AiSubmitInput): {
    transcription_id: string
    workspace_id: string
    title: string
    segments: AiSegmentInput[]
  } {
    return {
      transcription_id: input.transcriptionId,
      workspace_id: input.workspaceId ?? this.workspace(),
      title: input.title,
      segments: input.segments
    }
  }

  /** Janelas que falharam de vez voltam à fila (todas, sem id). */
  async retry(transcriptionId?: string): Promise<number> {
    const params = transcriptionId === undefined ? {} : { transcription_id: transcriptionId }
    const data = await this.call({ cmd: 'analysis_retry', params })
    return count(data.retried)
  }

  /** Transcrição excluída: remove chunks, vetores, análise e fila (CA17). */
  async forget(transcriptionId: string): Promise<void> {
    if (!this.readable()) return
    await this.call({
      cmd: 'knowledge_delete',
      params: { workspace_id: this.workspace(), transcription_id: transcriptionId }
    })
  }

  async searchKnowledge(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.readable()) return []
    const data = await this.call({
      cmd: 'knowledge_search',
      params: { workspace_id: this.workspace(), query, limit }
    })
    return asArray<SearchResult>(data.results)
  }

  async ask(question: string, limit = 5): Promise<KnowledgeAnswer> {
    const data = await this.call({
      cmd: 'knowledge_ask',
      params: { workspace_id: this.workspace(), question, limit }
    })
    return {
      answer: typeof data.answer === 'string' ? data.answer : '',
      model: typeof data.model === 'string' ? data.model : null,
      sources: asArray<SearchResult>(data.sources)
    }
  }

  async searchEntities(kind: AiEntityKind, query?: string, limit = 20): Promise<unknown[]> {
    if (!this.readable()) return []
    const params: {
      workspace_id: string
      kind: AiEntityKind
      query?: string
      limit: number
    } = { workspace_id: this.workspace(), kind, limit }
    if (query !== undefined) params.query = query
    const data = await this.call({ cmd: 'knowledge_search_entities', params })
    return asArray(data.entities)
  }

  async getAnalysis(transcriptionId: string): Promise<unknown> {
    if (!this.readable()) return null
    const data = await this.call({
      cmd: 'analysis_get',
      params: { workspace_id: this.workspace(), transcription_id: transcriptionId }
    })
    return data.analysis ?? null
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.readable()) return { configured: false, enabled: false }
    const data = await this.call({ cmd: 'ai_status', params: { workspace_id: this.workspace() } })
    return asRecord(data.status)
  }

  /** Diagnóstico da pilha de IA (Ollama, LLM, embeddings, RAG e banco). */
  async diagnose(): Promise<Record<string, unknown>> {
    const data = await this.call({ cmd: 'ai_diagnose' })
    return asRecord(data.diagnostics)
  }

  /** Baixa/atualiza um modelo no Ollama (o processo da IA atende outros pedidos enquanto isso). */
  async pullModel(model: string): Promise<AiPulledModel> {
    const data = await this.call({ cmd: 'ai_pull_model', params: { model } })
    return { model: typeof data.model === 'string' ? data.model : model }
  }

  /** Reindexa o workspace; o worker processa em segundo plano e aqui só se acompanha. */
  async reindex(
    workspaceId?: string,
    onProgress?: (progress: AiReindexProgress) => void
  ): Promise<number> {
    const workspace = workspaceId ?? this.workspace()
    this.reindexState.canceled = false
    const data = await this.call({ cmd: 'knowledge_reindex', params: { workspace_id: workspace } })
    for (;;) {
      const status = await this.status()
      onProgress?.(indexProgress(status))
      if (indexPending(status) <= 0) break
      await this.sleep(REINDEX_POLL_MS)
      if (this.isReindexCanceled()) {
        await this.call({ cmd: 'knowledge_reindex_cancel', params: { workspace_id: workspace } })
        break
      }
    }
    return count(data.enqueued)
  }

  /** Pede o cancelamento da reindexação em andamento. */
  cancelReindex(): void {
    this.reindexState.canceled = true
  }

  // Lido por método: o cancelamento chega de outra chamada enquanto o laço espera.
  private isReindexCanceled(): boolean {
    return this.reindexState.canceled
  }

  /** Escreve um backup do conhecimento do workspace no caminho informado. */
  async backup(path: string): Promise<AiKnowledgeBackup> {
    const data = await this.call({
      cmd: 'knowledge_backup',
      params: { workspace_id: this.workspace(), path }
    })
    return {
      documents: count(data.documents),
      chunks: count(data.chunks),
      analyses: count(data.analyses)
    }
  }

  /** Restaura um backup do caminho informado no workspace atual. */
  async restore(path: string): Promise<AiKnowledgeBackup> {
    const data = await this.call({
      cmd: 'knowledge_restore',
      params: { path, workspace_id: this.workspace() }
    })
    return {
      documents: count(data.documents),
      chunks: count(data.chunks),
      analyses: count(data.analyses)
    }
  }

  private workspace(): string {
    return this.deps.settings.get().ai.workspaceId
  }
}

/** Traduz as settings do app (camelCase) para o protocolo do worker (snake_case). */
export function toConfigureParams(
  ai: AiSettings,
  databasePath: string,
  secrets: Pick<AiSecrets, 'get'>
): ConfigureAiParams {
  return {
    enabled: ai.enabled,
    ollama_url: ai.ollamaUrl,
    llm_model: ai.llmModel,
    embedding_model: ai.embeddingModel,
    incremental_analysis_enabled: ai.incrementalAnalysisEnabled,
    final_analysis_enabled: ai.finalAnalysisEnabled,
    analysis_window_seconds: ai.analysisWindowSeconds,
    analysis_overlap_seconds: ai.analysisOverlapSeconds,
    max_concurrent_analysis: ai.maxConcurrentAnalysis,
    prompt_version: ai.promptVersion,
    request_timeout_seconds: ai.requestTimeoutSeconds,
    allow_remote_ollama: ai.allowRemoteOllama,
    database_path: databasePath,
    storage: toStorageParams(ai.storage, secrets)
  }
}

function optional(value: string): string | undefined {
  return value === '' ? undefined : value
}

/** Converte o armazenamento; container sem volume escolhido usa o volume padrão do app. */
export function toStorageParams(
  storage: AiStorage,
  secrets: Pick<AiSecrets, 'get'>
): ConfigureAiStorageParams {
  const container = storage.mode === 'local' || storage.mode === 'auto'
  return {
    mode: storage.mode,
    postgres: {
      host: storage.postgres.host,
      port: storage.postgres.port,
      database: storage.postgres.database,
      username: storage.postgres.username,
      password: secrets.get('postgres') ?? '',
      ssl_mode: storage.postgres.sslMode,
      connect_timeout: storage.postgres.connectTimeout
    },
    volume: optional(storage.volume) ?? (container ? DEFAULT_CONTAINER_VOLUME : undefined),
    password: optional(secrets.get('container') ?? ''),
    image: storage.image
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function indexPending(status: Record<string, unknown>): number {
  const index = asRecord(status.index)
  return count(index.PENDING) + count(index.PROCESSING)
}

function indexProgress(status: Record<string, unknown>): AiReindexProgress {
  const index = asRecord(status.index)
  let total = 0
  let completed = 0
  for (const [key, value] of Object.entries(index)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value
      if (key === 'COMPLETED') completed += value
    }
  }
  return { completed, total }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
