import { useCallback } from 'react'
import { DEFAULT_TRAY_SETTINGS, type TraySettings } from '../../../shared/settings'
import { useAppStore } from '../providers'
import { useSaveSettings } from './useSaveSettings'

export function useTraySettings(): TraySettings {
  return useAppStore((s) => s.settings?.tray ?? DEFAULT_TRAY_SETTINGS)
}

/** As configurações da bandeja são um objeto só: o patch leva o objeto inteiro. */
export function useSaveTray(): (patch: Partial<TraySettings>) => Promise<boolean> {
  const tray = useTraySettings()
  const save = useSaveSettings()
  return useCallback((patch) => save({ tray: { ...tray, ...patch } }), [tray, save])
}
