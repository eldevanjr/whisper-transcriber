import { vi } from 'vitest'
import type {
  DownloadEvent,
  LiveEvent,
  QueueEvent,
  SystemInfo,
  UpdateEvent,
  UpdateInfo
} from '../../src/shared/events'
import type { HistoryMeta } from '../../src/shared/history'
import type {
  AppInfo,
  HistoryDetail,
  LiveCapabilities,
  McpStatus,
  McpTestResult,
  MonitorVolume,
  TranscriberApi
} from '../../src/shared/ipc'
import {
  MCP_CLIENT_NAMES,
  type ClientState,
  type ClientStatus,
  type McpActivityLine,
  type McpClientId
} from '../../src/shared/mcp'
import type { ModelId } from '../../src/shared/models'
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/settings'

type Listener<T> = (payload: T) => void

let counter = 0

export function makeMeta(patch: Partial<HistoryMeta> = {}): HistoryMeta {
  counter += 1
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  return {
    id,
    fileName: 'aula.mp4',
    sourcePath: '/videos/aula.mp4',
    mediaKind: 'video',
    createdAt: new Date(Date.UTC(2026, 8, 23, 10, 0, counter)).toISOString(),
    status: 'done',
    model: 'medium',
    language: 'pt',
    languageDetected: 'pt',
    kind: 'file',
    duration: 125,
    error: null,
    ...patch
  }
}

export const SYSTEM_INFO: SystemInfo = {
  platform: 'linux',
  arch: 'x64',
  ramBytes: 16 * 1024 ** 3,
  gpu: null,
  cudaSupported: true,
  accelerator: null,
  recommendedDevice: 'cpu',
  recommendedModel: 'medium'
}

export const APP_INFO: AppInfo = { version: '0.1.0', platform: 'linux', settingsRecovered: false }

const SIZES: Record<ModelId, number> = {
  small: 484_000_000,
  medium: 1_530_000_000,
  'large-v3-turbo': 1_620_000_000,
  'large-v3': 3_090_000_000
}

/** Implementação em memória da API do preload, com emissores de eventos para os testes. */
export class FakeApi implements TranscriberApi {
  settingsValue: Settings
  entries: HistoryMeta[] = []
  corrupted: string[] = []
  details = new Map<string, HistoryDetail>()
  current: string | null = null
  pending: string[] = []
  installed: ModelId[] = ['medium']
  partial: ModelId[] = []
  installedGgml: ModelId[] = []
  cudaInstalled = false
  private readonly queueListeners = new Set<Listener<QueueEvent>>()
  private readonly downloadListeners = new Set<Listener<DownloadEvent>>()
  private readonly settingsListeners = new Set<Listener<Settings>>()

  constructor(settings: Partial<Settings> = {}) {
    this.settingsValue = { ...DEFAULT_SETTINGS, model: 'medium', uiLanguage: 'pt-BR', ...settings }
  }

  emitQueue(event: QueueEvent): void {
    for (const listener of this.queueListeners) listener(event)
  }

  emitDownload(event: DownloadEvent): void {
    for (const listener of this.downloadListeners) listener(event)
  }

  emitSettings(patch: Partial<Settings>): void {
    this.settingsValue = { ...this.settingsValue, ...patch }
    for (const listener of this.settingsListeners) listener(this.settingsValue)
  }

  listenerCount(): number {
    return (
      this.queueListeners.size +
      this.downloadListeners.size +
      this.settingsListeners.size +
      this.updateListeners.size +
      this.liveListeners.size
    )
  }

  settings = {
    get: vi.fn(() => Promise.resolve(this.settingsValue)),
    update: vi.fn((patch: Partial<Settings>) => {
      this.emitSettings(patch)
      return Promise.resolve(this.settingsValue)
    }),
    onChanged: (callback: Listener<Settings>) => subscribe(this.settingsListeners, callback)
  }

  queue = {
    enqueue: vi.fn((paths: string[]) =>
      Promise.resolve({
        accepted: paths.map((sourcePath) => makeMeta({ sourcePath, status: 'queued' })),
        rejected: [] as string[]
      })
    ),
    remove: vi.fn(() => Promise.resolve(null)),
    cancel: vi.fn(() => Promise.resolve(null)),
    state: vi.fn(() => Promise.resolve({ current: this.current, pending: [...this.pending] })),
    retry: vi.fn((id: string) => Promise.resolve(makeMeta({ id, status: 'queued' }))),
    onEvent: (callback: Listener<QueueEvent>) => subscribe(this.queueListeners, callback)
  }

  history = {
    list: vi.fn(() =>
      Promise.resolve({ entries: [...this.entries], corrupted: [...this.corrupted] })
    ),
    get: vi.fn((id: string) => {
      const detail = this.details.get(id)
      const meta = this.entries.find((entry) => entry.id === id)
      if (detail) return Promise.resolve(detail)
      if (!meta) return Promise.reject(apiError('NOT_FOUND', 'não encontrado'))
      return Promise.resolve({ meta, transcript: [], videoAvailable: true, hasRedo: false })
    }),
    clear: vi.fn(() => Promise.resolve({ count: this.entries.length, bytes: 1000 })),
    stats: vi.fn(() => Promise.resolve({ count: this.entries.length, bytes: 52_428_800 })),
    remove: vi.fn(() => Promise.resolve(null)),
    setVersion: vi.fn((id: string, version: 'live' | 'redo') => {
      const meta = this.entries.find((entry) => entry.id === id) ?? makeMeta({ id })
      const updated = { ...meta, activeVersion: version }
      this.emitQueue({ type: 'job', meta: updated })
      return Promise.resolve(updated)
    })
  }

  models = {
    status: vi.fn((format?: string) =>
      Promise.resolve({
        installed: [...(format === 'ggml' ? this.installedGgml : this.installed)],
        partial: format === 'ggml' ? [] : [...this.partial],
        sizes: SIZES
      })
    ),
    install: vi.fn(() => Promise.resolve(null)),
    remove: vi.fn(() => Promise.resolve(null))
  }

  cuda = {
    status: vi.fn(() =>
      Promise.resolve({ supported: true, installed: this.cudaInstalled, sizeBytes: 1_200_000_000 })
    ),
    install: vi.fn(() => Promise.resolve(null)),
    remove: vi.fn(() => Promise.resolve(null))
  }

  downloads = {
    cancel: vi.fn(() => Promise.resolve(null)),
    onEvent: (callback: Listener<DownloadEvent>) => subscribe(this.downloadListeners, callback)
  }

  engine = { selfTest: vi.fn(() => Promise.resolve(null)) }

  files = {
    choose: vi.fn(() => Promise.resolve([] as string[])),
    pathFor: vi.fn((file: File) => `/soltos/${file.name}`),
    save: vi.fn(() => Promise.resolve(true))
  }

  clipboard = { write: vi.fn(() => Promise.resolve(null)) }

  system = {
    info: vi.fn(() => Promise.resolve(SYSTEM_INFO)),
    openExternal: vi.fn<(url: string) => Promise<null>>(() => Promise.resolve(null)),
    openDataFolder: vi.fn(() => Promise.resolve(null))
  }

  private readonly updateListeners = new Set<Listener<UpdateEvent>>()
  private readonly liveListeners = new Set<Listener<LiveEvent>>()

  emitLive(event: LiveEvent): void {
    for (const listener of this.liveListeners) listener(event)
  }

  live = {
    capabilities: vi.fn((): Promise<LiveCapabilities> =>
      Promise.resolve({ systemAudio: 'monitor' })
    ),
    monitorVolume: vi.fn((): Promise<MonitorVolume | null> => Promise.resolve(null)),
    setMonitorVolume: vi.fn((percent: number): Promise<MonitorVolume | null> =>
      Promise.resolve({ sink: 'Fone USB', percent, muted: false })
    ),
    start: vi.fn(() => Promise.resolve({ sessionId: 's1', itemId: null as string | null })),
    stop: vi.fn(() => Promise.resolve(null as HistoryMeta | null)),
    pause: vi.fn(() => Promise.resolve(null)),
    resume: vi.fn(() => Promise.resolve(null)),
    sendAudio: vi.fn(),
    onEvent: (callback: Listener<LiveEvent>) => subscribe(this.liveListeners, callback)
  }

  emitUpdate(event: UpdateEvent): void {
    for (const listener of this.updateListeners) listener(event)
  }

  updates = {
    check: vi.fn((): Promise<UpdateInfo | null> => Promise.resolve(null)),
    install: vi.fn(() => Promise.resolve(null)),
    onEvent: (callback: Listener<UpdateEvent>) => subscribe(this.updateListeners, callback)
  }

  app = { info: vi.fn(() => Promise.resolve(APP_INFO)) }

  mcpStatus = vi.fn((): Promise<McpStatus> =>
    Promise.resolve({
      launcherOk: true,
      launcherError: null,
      launcherPath: '/home/u/.config/Whisper Transcriber/mcp/whisper-transcriber-mcp',
      bridgeOk: true,
      clients: []
    })
  )

  mcpConnect = vi.fn((id: McpClientId): Promise<ClientStatus> =>
    Promise.resolve(makeClientStatus(id, 'connected'))
  )

  mcpDisconnect = vi.fn((id: McpClientId): Promise<ClientStatus> =>
    Promise.resolve(makeClientStatus(id, 'found'))
  )

  mcpTest = vi.fn((): Promise<McpTestResult> => Promise.resolve({ ok: true, tools: 8 }))

  mcpActivity = vi.fn((): Promise<McpActivityLine[]> => Promise.resolve([]))
}

export function makeClientStatus(id: McpClientId, state: ClientState): ClientStatus {
  return {
    id,
    name: MCP_CLIENT_NAMES[id],
    state,
    lastUsedAt: null,
    restartNeeded: false,
    manual: { kind: 'json', text: `{ "${id}": "config manual" }` }
  }
}

function subscribe<T>(listeners: Set<Listener<T>>, callback: Listener<T>): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

/** Formato que a ponte (contextBridge) entrega de verdade: objeto simples, não Error. */
export function apiError(code: string, message = 'falhou'): { code: string; message: string } {
  return { code, message }
}
