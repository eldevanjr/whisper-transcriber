import { useCallback } from 'react'
import { DEFAULT_LIVE_SETTINGS, type LiveSettings } from '../../../shared/settings'
import { useAppStore } from '../providers'
import { useSaveSettings } from './useSaveSettings'

export function useLiveSettings(): LiveSettings {
  return useAppStore((s) => s.settings?.live ?? DEFAULT_LIVE_SETTINGS)
}

/** As configurações do ao vivo são um objeto só: o patch leva o objeto inteiro. */
export function useSaveLive(): (patch: Partial<LiveSettings>) => Promise<boolean> {
  const live = useLiveSettings()
  const save = useSaveSettings()
  return useCallback((patch) => save({ live: { ...live, ...patch } }), [live, save])
}
