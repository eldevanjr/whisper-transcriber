import type { ErrorInfo } from './errors'
import type {
  DownloadEvent,
  DownloadTarget,
  EnqueueResult,
  QueueEvent,
  QueueState,
  SystemInfo,
  UpdateEvent,
  UpdateInfo
} from './events'
import type { HistoryList, HistoryMeta, StorageStats, TranscriptEntry } from './history'
import type { ModelFormat, ModelId } from './models'
import type { Settings, SettingsPatch } from './settings'

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
  appInfo: 'app:info'
} as const

export const EVENTS = {
  queue: 'event:queue',
  download: 'event:download',
  settings: 'event:settings',
  update: 'event:update'
} as const

export interface HistoryDetail {
  meta: HistoryMeta
  transcript: TranscriptEntry[]
  videoAvailable: boolean
}

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
}
