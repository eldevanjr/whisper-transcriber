import type { ErrorInfo } from './errors'
import type {
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
  liveCapabilities: 'live:capabilities'
} as const

export const EVENTS = {
  queue: 'event:queue',
  download: 'event:download',
  settings: 'event:settings',
  update: 'event:update',
  live: 'event:live'
} as const

/** Canais sem resposta (renderer → main): os blocos de áudio do ao vivo, 10 por segundo. */
export const SEND = {
  liveAudio: 'live:audio'
} as const

export interface LiveCapabilities {
  systemAudio: 'loopback' | 'monitor' | 'unavailable'
}

export interface LiveStartInput {
  tracks: Track[]
  test: boolean
  title: string
}

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
    start(input: LiveStartInput): Promise<{ sessionId: string; itemId: string | null }>
    stop(): Promise<HistoryMeta | null>
    pause(): Promise<null>
    resume(): Promise<null>
    /** Bloco de 100 ms (4800 amostras a 48 kHz) de uma faixa; sem resposta. */
    sendAudio(track: Track, seq: number, pcm: Int16Array): void
    onEvent(callback: (event: LiveEvent) => void): Unsubscribe
  }
}
