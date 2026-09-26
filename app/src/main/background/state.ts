import { formatAccelerator } from '../../shared/accelerator'
import type { LiveState } from '../../shared/events'
import { formatTime } from '../../shared/format'
import type { TrayIconState } from './icons'
import type { Translate } from './texts'

export interface TrayState {
  live: LiveState
  /** Sessão de teste da tela do ao vivo (não grava). */
  test: boolean
  /** Segundos gravados, sem as pausas. */
  elapsed: number
  /** Onboarding concluído (há modelo). */
  ready: boolean
  /** Atalho registrado agora; null se desligado ou recusado. */
  shortcut: string | null
  aiUnseen: boolean
  platform: string
}

export type MenuAction = 'toggle' | 'pause' | 'resume' | 'open' | 'setup' | 'quit'
export type MenuEntry =
  | { type: 'separator' }
  | { type: 'item'; label: string; action: MenuAction | null; enabled: boolean }

const SEPARATOR: MenuEntry = { type: 'separator' }

/** Gravação de verdade em andamento (o teste da tela não conta). */
export function inSession(state: TrayState): boolean {
  return !state.test && (state.live === 'recording' || state.live === 'paused')
}

export function iconState(state: TrayState): TrayIconState {
  if (inSession(state)) return state.live === 'paused' ? 'paused' : 'recording'
  return state.aiUnseen ? 'ai' : 'normal'
}

export function tooltip(state: TrayState, t: Translate): string {
  if (!inSession(state)) return t('background.tooltip')
  const key = state.live === 'paused' ? 'background.tooltipPaused' : 'background.tooltipRecording'
  return t(key, { time: formatTime(state.elapsed) })
}

/** Texto ao lado do ícone (só o macOS mostra): o tempo durante a sessão. */
export function trayTitle(state: TrayState): string {
  return inSession(state) ? formatTime(state.elapsed) : ''
}

function toggleEntry(state: TrayState, t: Translate): MenuEntry {
  const stopping = inSession(state) || (state.test && state.live !== 'idle')
  const text = t(stopping ? 'background.stop' : 'background.start')
  const label = state.shortcut
    ? t('background.withShortcut', {
        label: text,
        shortcut: formatAccelerator(state.shortcut, state.platform)
      })
    : text
  const busy = state.live === 'starting' || state.live === 'stopping'
  return { type: 'item', label, action: 'toggle', enabled: state.ready && !busy }
}

function sessionEntries(state: TrayState, t: Translate): MenuEntry[] {
  const paused = state.live === 'paused'
  return [
    {
      type: 'item',
      label: t(paused ? 'background.statusPaused' : 'background.statusRecording'),
      action: null,
      enabled: false
    },
    toggleEntry(state, t),
    {
      type: 'item',
      label: t(paused ? 'background.resume' : 'background.pause'),
      action: paused ? 'resume' : 'pause',
      enabled: true
    }
  ]
}

export function menuModel(state: TrayState, t: Translate): MenuEntry[] {
  const top = inSession(state) ? sessionEntries(state, t) : [toggleEntry(state, t)]
  const setup: MenuEntry[] = state.ready
    ? []
    : [{ type: 'item', label: t('background.finishSetup'), action: 'setup', enabled: true }]
  return [
    ...top,
    ...setup,
    SEPARATOR,
    { type: 'item', label: t('background.open'), action: 'open', enabled: true },
    SEPARATOR,
    { type: 'item', label: t('background.quit'), action: 'quit', enabled: true }
  ]
}
