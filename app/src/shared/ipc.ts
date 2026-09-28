import type { ErrorInfo } from './errors'
import type {
  AiReindexProgress,
  DownloadEvent,
  DownloadTarget,
  EnqueueResult,
  LiveEvent,
  QueueEvent,
  QueueState,
  SystemInfo,
  UpdateEvent,
  UpdateInfo
} from './events'
import type { HistoryList, HistoryMeta, StorageStats, TranscriptEntry } from './history'
import type { ClientStatus, McpActivityLine, McpClientId } from './mcp'
import type { ModelFormat, ModelId } from './models'
import type { Settings, SettingsPatch, Track } from './settings'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo }

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  queueEnqueue: 'queue:enqueue',
  queueRemove: 'queue:remove',
  queueCancel: 'queue:cancel',
  queueState: 'queue:state',
  queueRetry: 'queue:retry',
  historyList: 'history:list',
  historyGet: 'history:get',
  historyClear: 'history:clear',
  historyStats: 'history:stats',
  historyRemove: 'history:remove',
  historySetVersion: 'history:set-version',
  modelsStatus: 'models:status',
  modelsInstall: 'models:install',
  modelsRemove: 'models:remove',
  cudaStatus: 'cuda:status',
  cudaInstall: 'cuda:install',
  cudaRemove: 'cuda:remove',
  downloadCancel: 'download:cancel',
  engineSelfTest: 'engine:self-test',
  filesChoose: 'files:choose',
  fileSave: 'file:save',
  clipboardWrite: 'clipboard:write',
  systemInfo: 'system:info',
  openExternal: 'shell:open-external',
  openDataFolder: 'shell:open-data-folder',
  updatesCheck: 'updates:check',
  updatesInstall: 'updates:install',
  appInfo: 'app:info',
  liveStart: 'live:start',
  liveStop: 'live:stop',
  livePause: 'live:pause',
  liveResume: 'live:resume',
  liveCapabilities: 'live:capabilities',
  liveMonitorVolume: 'live:monitor-volume',
  liveSetMonitorVolume: 'live:set-monitor-volume',
  mcpStatus: 'mcp:status',
  mcpConnect: 'mcp:connect',
  mcpDisconnect: 'mcp:disconnect',
  mcpTest: 'mcp:test',
  mcpActivity: 'mcp:activity',
  aiSecretsStatus: 'ai:secrets-status',
  aiSecretSet: 'ai:secret-set',
  aiSecretClear: 'ai:secret-clear',
  aiStatus: 'ai:status',
  aiAnalysis: 'ai:analysis',
  aiDiagnose: 'ai:diagnose',
  aiReindex: 'ai:reindex',
  aiBackup: 'ai:backup',
  aiRestore: 'ai:restore',
  aiPullModel: 'ai:pull-model',
  aiCancelReindex: 'ai:cancel-reindex',
  aiReanalyze: 'ai:reanalyze',
  aiRetry: 'ai:retry',
  aiAsk: 'ai:ask',
  backgroundReport: 'background:report',
  backgroundShortcutStatus: 'background:shortcut-status',
  backgroundSuspendShortcut: 'background:suspend-shortcut'
} as const

export const EVENTS = {
  queue: 'event:queue',
  download: 'event:download',
  settings: 'event:settings',
  update: 'event:update',
  live: 'event:live',
  ai: 'event:ai',
  aiReindex: 'event:ai-reindex',
  backgroundCommand: 'event:background-command',
  backgroundNavigate: 'event:background-navigate'
} as const

/** Canais sem resposta (renderer → main): os blocos de áudio do ao vivo, 10 por segundo. */
export const SEND = {
  liveAudio: 'live:audio'
} as const

export interface LiveCapabilities {
  systemAudio: 'loopback' | 'monitor' | 'unavailable'
}

/** Volume do monitor da saída padrão (Linux/PipeWire): de onde vem o áudio dos "Outros". */
export interface MonitorVolume {
  /** Nome da saída de áudio, como o sistema mostra. */
  sink: string
  /** 0–100, na escala dos mixers (pavucontrol). */
  percent: number
  muted: boolean
}

/** ok = registrado; taken = outro programa usa; unavailable = o sistema recusou (Wayland). */
export type ShortcutStatus = 'ok' | 'off' | 'taken' | 'unavailable'

export interface LiveStartInput {
  tracks: Track[]
  test: boolean
  title: string
}

/** Onde a janela abre ao clicar numa notificação. */
export type NavigateTarget = { kind: 'item'; id: string } | { kind: 'live' } | { kind: 'window' }

/** Do main para o renderer: a bandeja ou o atalho pediram começar/parar, pausar ou retomar. */
export interface BackgroundCommand {
  action: 'toggle' | 'pause' | 'resume'
}

/** Do renderer para o main: o que só ele sabe e vira notificação. */
export type BackgroundReport = { kind: 'startFailed'; error: ErrorInfo } | { kind: 'deviceLost' }

export interface HistoryDetail {
  meta: HistoryMeta
  /** A versão ativa (item ao vivo: a refeita ou a ao vivo). */
  transcript: TranscriptEntry[]
  videoAvailable: boolean
  /** Item ao vivo já refeito: dá para escolher a versão. */
  hasRedo: boolean
}

export type TranscriptVersion = 'live' | 'redo'

export interface ModelsStatus {
  installed: ModelId[]
  /** Downloads interrompidos (pasta começada, sem marca de concluído). */
  partial: ModelId[]
  sizes: Record<ModelId, number>
}

export interface CudaStatus {
  supported: boolean
  installed: boolean
  sizeBytes: number
}

export interface SaveTextInput {
  defaultName: string
  content: string
}

export interface AppInfo {
  version: string
  platform: string
  settingsRecovered: boolean
}

/** Retrato da seção de IAs (spec §10.2). */
export interface McpStatus {
  launcherOk: boolean
  /** Motivo quando o lançador não foi gravado ("Com problema: <motivo>"); null quando OK. */
  launcherError: string | null
  launcherPath: string
  bridgeOk: boolean
  clients: ClientStatus[]
}

/** Resultado do "Testar conexão" (spec §10.2). */
export interface McpTestResult {
  ok: true
  tools: number
}

/** Senhas guardadas no cofre do sistema (criptografia do SO), não nas settings. */
export const AI_SECRET_KINDS = ['postgres', 'container'] as const
export type AiSecretKind = (typeof AI_SECRET_KINDS)[number]

export interface AiSecretsStatus {
  /** Criptografia do sistema disponível; sem ela, a senha não é gravada em disco. */
  available: boolean
  postgres: boolean
  container: boolean
}

/** Entidades da análise incremental (worker → UI). */
export type AiEntityKind = 'topic' | 'task' | 'decision' | 'problem' | 'question' | 'person'

export interface AiAnalysisItem {
  id: string
  kind: AiEntityKind
  text: string
  detail: string | null
  confidence: number
  /** DETECTED/UPDATED/CONFIRMED/CANCELLED (plano §7); null em análises antigas. */
  state: string | null
  start: number | null
  end: number | null
}

export interface AiAnalysis {
  summary: string | null
  items: AiAnalysisItem[]
  model: string | null
}

export interface AiIndexProgress {
  total: number
  completed: number
  pending: number
  failed: number
}

export interface AiStorageStatus {
  kind: string
  fallback: boolean
  reason: string | null
}

export interface AiStatus {
  configured: boolean
  enabled: boolean
  pendingAnalysis: number
  /** Janelas que falharam de vez (dá para tentar de novo). */
  failedAnalysis: number
  index: AiIndexProgress
  storage: AiStorageStatus | null
  /** Motivo de a IA não rodar (ex.: Ollama fora da rede local sem permissão). */
  blocked: string | null
  /** O índice foi gerado com outro modelo de embedding: é preciso reindexar (CA18). */
  reindexRequired: boolean
}

/** Trecho que fundamenta uma resposta do RAG (plano §18: clique posiciona o player). */
export interface AiAnswerSource {
  transcriptionId: string | null
  title: string | null
  text: string
  start: number | null
  end: number | null
}

export interface AiAnswer {
  answer: string
  model: string | null
  sources: AiAnswerSource[]
}

/** Uma verificação do diagnóstico da pilha de IA (Whisper/Ollama/LLM/embeddings/RAG/PostgreSQL). */
export interface AiDiagnosticCheck {
  name: string
  ok: boolean
  detail: string | null
}

/** Backup/restauração do conhecimento e das análises; `null` quando o usuário cancela. */
export interface AiKnowledgeBackup {
  documents: number
  chunks: number
  analyses: number
}

/** Modelo baixado via Ollama (`pull`); devolve o nome confirmado. */
export interface AiPulledModel {
  model: string
}

/** Eventos espontâneos da IA local enviados pelo main ao renderer (sem polling). */
export type AiEvent =
  | { type: 'status'; status: AiStatus }
  | { type: 'analysis'; transcriptionId: string; analysis: AiAnalysis; final: boolean }
  | { type: 'search'; results: unknown[] }
  | { type: 'pull'; model: string; completed: number; total: number }

/** Commandos de IA local expostos pelo main ao renderer (fonte única da API). */
export interface AiApi {
  secretsStatus(): Promise<AiSecretsStatus>
  setSecret(kind: AiSecretKind, value: string): Promise<AiSecretsStatus>
  clearSecret(kind: AiSecretKind): Promise<AiSecretsStatus>
  status(): Promise<AiStatus>
  /** Análise (tópicos, tarefas, …) da transcrição; vazia quando ainda não há. */
  analysis(id: string): Promise<AiAnalysis>
  /** Refaz a análise da transcrição do histórico (substitui a anterior). */
  reanalyze(id: string): Promise<null>
  /** Tenta de novo as janelas que falharam; devolve quantas voltaram à fila. */
  retry(id: string): Promise<number>
  /** Pergunta ao conhecimento (RAG), com as fontes. */
  ask(question: string): Promise<AiAnswer>
  /** Diagnóstico sob demanda: Ollama, LLM, embeddings, RAG e banco. */
  diagnose(): Promise<AiDiagnosticCheck[]>
  /** Reindexa o conhecimento do workspace e devolve quantos itens entraram na fila. */
  reindex(): Promise<number>
  /** Cancela a reindexação em andamento (no próximo lote). */
  cancelReindex(): Promise<null>
  /** Progresso da reindexação, enquanto ela roda (plano §26). */
  onReindexProgress(callback: (progress: AiReindexProgress) => void): Unsubscribe
  /** Salva um backup do conhecimento; null se o usuário cancelar. */
  backup(): Promise<AiKnowledgeBackup | null>
  /** Restaura um backup escolhido pelo usuário; null se cancelar. */
  restore(): Promise<AiKnowledgeBackup | null>
  /** Baixa/atualiza um modelo no Ollama (o resto da IA segue atendendo). */
  pullModel(model: string): Promise<AiPulledModel>
  /** Status/análise/busca/pull da IA local, ao vivo (plano §20). */
  onEvent(callback: (event: AiEvent) => void): Unsubscribe
}

export interface RetryInput {
  id: string
  sourcePath?: string
}

export type Unsubscribe = () => void

export interface TranscriberApi {
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<Settings>
    onChanged(callback: (settings: Settings) => void): Unsubscribe
  }
  queue: {
    enqueue(paths: string[]): Promise<EnqueueResult>
    remove(id: string): Promise<null>
    cancel(): Promise<null>
    state(): Promise<QueueState>
    retry(id: string, sourcePath?: string): Promise<HistoryMeta>
    onEvent(callback: (event: QueueEvent) => void): Unsubscribe
  }
  history: {
    list(): Promise<HistoryList>
    get(id: string): Promise<HistoryDetail>
    clear(): Promise<StorageStats>
    stats(): Promise<StorageStats>
    remove(id: string): Promise<null>
    setVersion(id: string, version: TranscriptVersion): Promise<HistoryMeta>
  }
  models: {
    /** Formato ct2 (faster-whisper) por padrão; ggml para o whisper.cpp (GPU Vulkan/Metal). */
    status(format?: ModelFormat): Promise<ModelsStatus>
    install(id: ModelId, format?: ModelFormat): Promise<null>
    remove(id: ModelId, format?: ModelFormat): Promise<null>
  }
  cuda: {
    status(): Promise<CudaStatus>
    install(): Promise<null>
    remove(): Promise<null>
  }
  downloads: {
    cancel(target: DownloadTarget): Promise<null>
    onEvent(callback: (event: DownloadEvent) => void): Unsubscribe
  }
  engine: { selfTest(): Promise<null> }
  files: {
    choose(): Promise<string[]>
    pathFor(file: File): string
    save(input: SaveTextInput): Promise<boolean>
  }
  clipboard: { write(text: string): Promise<null> }
  system: {
    info(): Promise<SystemInfo>
    openExternal(url: string): Promise<null>
    openDataFolder(): Promise<null>
  }
  updates: {
    check(): Promise<UpdateInfo | null>
    /** Reinicia aplicando a atualização já baixada (modo automático). */
    install(): Promise<null>
    onEvent(callback: (event: UpdateEvent) => void): () => void
  }
  app: { info(): Promise<AppInfo> }
  live: {
    /** O que o sistema oferece para o áudio dos "Outros". */
    capabilities(): Promise<LiveCapabilities>
    /** null fora do Linux ou sem PipeWire. */
    monitorVolume(): Promise<MonitorVolume | null>
    setMonitorVolume(percent: number): Promise<MonitorVolume | null>
    start(input: LiveStartInput): Promise<{ sessionId: string; itemId: string | null }>
    stop(): Promise<HistoryMeta | null>
    pause(): Promise<null>
    resume(): Promise<null>
    /** Bloco de 100 ms (4800 amostras a 48 kHz) de uma faixa; sem resposta. */
    sendAudio(track: Track, seq: number, pcm: Int16Array): void
    onEvent(callback: (event: LiveEvent) => void): Unsubscribe
  }
  /** Seção "IAs (MCP)" (spec §10.2). */
  mcpStatus(): Promise<McpStatus>
  mcpConnect(id: McpClientId): Promise<ClientStatus>
  mcpDisconnect(id: McpClientId): Promise<ClientStatus>
  mcpTest(): Promise<McpTestResult>
  mcpActivity(): Promise<McpActivityLine[]>
  ai: AiApi
  background: {
    /** Falha ao começar pela bandeja ou microfone perdido: o main notifica. */
    report(report: BackgroundReport): Promise<null>
    shortcutStatus(): Promise<ShortcutStatus>
    /** Enquanto a tela grava um atalho novo, o atual não dispara. */
    suspendShortcut(on: boolean): Promise<null>
    onCommand(callback: (command: BackgroundCommand) => void): Unsubscribe
    onNavigate(callback: (target: NavigateTarget) => void): Unsubscribe
  }
}
