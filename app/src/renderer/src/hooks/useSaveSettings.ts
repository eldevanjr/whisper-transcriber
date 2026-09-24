import { useCallback } from 'react'
import type { SettingsPatch } from '../../../shared/settings'
import { useApi } from '../providers'
import { useGuard } from './useGuard'

/** Salva na hora (sem botão "Salvar"); falha vira aviso. */
export function useSaveSettings(): (patch: SettingsPatch) => Promise<boolean> {
  const api = useApi()
  const guard = useGuard()
  return useCallback((patch) => guard(() => api.settings.update(patch)), [api, guard])
}
