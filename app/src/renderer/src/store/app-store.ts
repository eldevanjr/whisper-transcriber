import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ErrorInfo } from '../../../shared/errors'
import {
  downloadKey,
  type DownloadEvent,
  DownloadTarget,
  Phase,
  QueueEvent,
  QueueState,
  SystemInfo
} from '../../../shared/events'
import type { HistoryMeta, Segment } from '../../../shared/history'
import type { AppInfo, TranscriberApi } from '../../../shared/ipc'
import type { Sample } from '../lib/rate'
import type { Settings } from '../../../shared/settings'

export interface Progress {
  pct: number
  processedS: number
  totalS: number
  speed: number
}

export interface LiveJob {
  phase: Phase | null
  progress: Progress | null
  segments: Segment[]
}

export interface DownloadState {
  status: 'active' | 'done' | 'failed' | 'canceled'
  received: number
  total: number
  /** Últimas leituras (tempo, bytes) para a velocidade média. */
  samples: Sample[]
  error?: ErrorInfo
}

export interface Notice {
  id: number
  kind: 'info' | 'error'
  key: string
  values?: Record<string, string>
  error?: ErrorInfo
}

export type SettingsSection =
  'general' | 'transcription' | 'storage' | 'help' | 'about' | 'licenses'

export interface AppState {
  ready: boolean
  /** Fixado na carga: o onboarding grava o modelo antes do autoteste e não pode sumir no meio. */
  onboarding: boolean
  settings: Settings | null
  appInfo: AppInfo | null
  systemInfo: SystemInfo | null
  queue: QueueState
  entries: Record<string, HistoryMeta>
  corrupted: string[]
  live: Record<string, LiveJob>
  downloads: Record<string, DownloadState>
  notices: Notice[]
  selectedId: string | null
  view: 'main' | 'settings'
  settingsSection: SettingsSection
}

export interface AppActions {
  init: () => Promise<() => void>
  finishOnboarding: () => void
  refreshHistory: () => Promise<void>
  setSettings: (settings: Settings) => void
  select: (id: string | null) => void
  openSettings: (section?: SettingsSection) => void
  closeSettings: () => void
  pushNotice: (notice: Omit<Notice, 'id'>) => void
  dismissNotice: (id: number) => void
}

export type AppStore = StoreApi<AppState & AppActions>

const EMPTY_LIVE: LiveJob = { phase: null, progress: null, segments: [] }
const TERMINAL = new Set(['done', 'failed', 'canceled', 'interrupted'])

export function targetKey(target: DownloadTarget): string {
  return downloadKey(target)
}

export function selectEntries(state: AppState): HistoryMeta[] {
  return Object.values(state.entries).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const without = (list: string[], id: string): string[] => list.filter((item) => item !== id)

function queueAfterJob(queue: QueueState, meta: HistoryMeta): QueueState {
  const pending = without(queue.pending, meta.id)
  if (meta.status === 'queued') return { ...queue, pending: [...pending, meta.id] }
  if (meta.status === 'processing') return { current: meta.id, pending }
  const current = queue.current === meta.id && TERMINAL.has(meta.status) ? null : queue.current
  return { current, pending }
}

function withLive(state: AppState, jobId: string, patch: Partial<LiveJob>): Partial<AppState> {
  const live = state.live[jobId] ?? EMPTY_LIVE
  return { live: { ...state.live, [jobId]: { ...live, ...patch } } }
}

/** Junta os trechos do parcial em disco com os que chegaram ao vivo, sem repetir. */
function mergeSegments(saved: Segment[], live: Segment[]): Segment[] {
  const byStart = new Map<number, Segment>()
  for (const segment of [...saved, ...live]) byStart.set(segment.start, segment)
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

function onJob(state: AppState, meta: HistoryMeta): Partial<AppState> {
  const next: Partial<AppState> = {
    entries: { ...state.entries, [meta.id]: meta },
    queue: queueAfterJob(state.queue, meta)
  }
  if (meta.status !== 'processing') return next
  return {
    ...next,
    live: { ...state.live, [meta.id]: EMPTY_LIVE },
    selectedId: state.selectedId ?? meta.id
  }
}

function onRemoved(state: AppState, jobId: string): Partial<AppState> {
  const entries = Object.fromEntries(Object.entries(state.entries).filter(([id]) => id !== jobId))
  return {
    entries,
    corrupted: without(state.corrupted, jobId),
    queue: { ...state.queue, pending: without(state.queue.pending, jobId) },
    selectedId: state.selectedId === jobId ? null : state.selectedId
  }
}

function onProgress(
  state: AppState,
  event: Extract<QueueEvent, { type: 'progress' }>
): Partial<AppState> {
  const { pct, processedS, totalS, speed } = event
  // A fase só vem nas transições: depois de recarregar a tela, progresso implica transcrição.
  const phase = state.live[event.jobId]?.phase ?? 'transcribing'
  return withLive(state, event.jobId, { phase, progress: { pct, processedS, totalS, speed } })
}

function reduceQueue(state: AppState, event: QueueEvent): Partial<AppState> {
  switch (event.type) {
    case 'job':
      return onJob(state, event.meta)
    case 'removed':
      return onRemoved(state, event.jobId)
    case 'phase':
      // Cada fase tem a própria barra (extração do áudio, depois transcrição).
      return withLive(state, event.jobId, { phase: event.phase, progress: null })
    case 'progress':
      return onProgress(state, event)
    case 'segment': {
      const segments = [...(state.live[event.jobId] ?? EMPTY_LIVE).segments, event.segment]
      return withLive(state, event.jobId, { segments })
    }
    case 'notice':
      return {}
  }
}

const MAX_SAMPLES = 30

function reduceDownload(state: AppState, event: DownloadEvent, now: number): Partial<AppState> {
  const key = targetKey(event.target)
  const previous = state.downloads[key] ?? { status: 'active', received: 0, total: 0, samples: [] }
  const next: DownloadState = (() => {
    switch (event.type) {
      case 'progress': {
        const samples = previous.status === 'active' ? previous.samples : []
        return {
          status: 'active',
          received: event.received,
          total: event.total,
          samples: [...samples.slice(-MAX_SAMPLES), { t: now, bytes: event.received }]
        }
      }
      case 'done':
        return { ...previous, status: 'done', received: previous.total }
      case 'failed':
        return { ...previous, status: 'failed', error: event.error }
      case 'canceled':
        return { ...previous, status: 'canceled' }
    }
  })()
  return { downloads: { ...state.downloads, [key]: next } }
}

export function createAppStore(
  api: TranscriberApi,
  now: () => number = () => performance.now()
): AppStore {
  let noticeId = 0
  return createStore<AppState & AppActions>()((set, get) => {
    const pushNotice = (notice: Omit<Notice, 'id'>): void => {
      noticeId += 1
      set((state) => ({ notices: [...state.notices, { ...notice, id: noticeId }] }))
    }

    const onQueueEvent = (event: QueueEvent): void => {
      if (event.type === 'notice') pushNotice({ kind: 'info', key: 'notices.cudaFallback' })
      set((state) => reduceQueue(state, event))
    }

    const rehydrate = async (current: string | null): Promise<void> => {
      if (current === null) return
      try {
        const detail = await api.history.get(current)
        const saved = detail.transcript.map((e) => ({ start: e.inicio, end: e.fim, text: e.texto }))
        set((state) => {
          const segments = mergeSegments(saved, state.live[current]?.segments ?? [])
          return { ...withLive(state, current, { segments }), selectedId: current }
        })
      } catch {
        // o job pode ter acabado entre state() e get(): os próximos eventos corrigem a tela
      }
    }

    return {
      ready: false,
      onboarding: false,
      settings: null,
      appInfo: null,
      systemInfo: null,
      queue: { current: null, pending: [] },
      entries: {},
      corrupted: [],
      live: {},
      downloads: {},
      notices: [],
      selectedId: null,
      view: 'main',
      settingsSection: 'general',

      async init() {
        // Assina antes de buscar: nada que o main emitir durante a carga se perde.
        const stops = [
          api.queue.onEvent(onQueueEvent),
          api.downloads.onEvent((event) => {
            set((state) => reduceDownload(state, event, now()))
          }),
          api.settings.onChanged((next) => {
            set({ settings: next })
          })
        ]
        const [settings, appInfo, systemInfo, queue, history] = await Promise.all([
          api.settings.get(),
          api.app.info(),
          api.system.info(),
          api.queue.state(),
          api.history.list()
        ])
        const loaded = Object.fromEntries(history.entries.map((meta) => [meta.id, meta]))
        set((state) => ({
          settings,
          appInfo,
          systemInfo,
          queue,
          entries: { ...loaded, ...state.entries }, // eventos da carga são mais novos
          corrupted: history.corrupted,
          onboarding: settings.model === null
        }))
        await rehydrate(queue.current)
        set({ ready: true })
        return () => {
          for (const stop of stops) stop()
        }
      },

      async refreshHistory() {
        const history = await api.history.list()
        const entries = Object.fromEntries(history.entries.map((meta) => [meta.id, meta]))
        set({ entries, corrupted: history.corrupted })
      },

      finishOnboarding() {
        set({ onboarding: false })
      },
      setSettings(settings) {
        set({ settings })
      },
      select(id) {
        set({ selectedId: id })
      },
      openSettings(section = 'general') {
        set({ view: 'settings', settingsSection: section })
      },
      closeSettings() {
        set({ view: 'main' })
      },
      pushNotice,
      dismissNotice(id) {
        set({ notices: get().notices.filter((notice) => notice.id !== id) })
      }
    }
  })
}
