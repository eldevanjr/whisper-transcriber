import { useCallback } from 'react'
import { errorInfoOf } from '../errors'
import { useAppStore } from '../providers'

export type Guard = (action: () => Promise<unknown>) => Promise<boolean>

/** Executa uma ação e transforma a falha num aviso traduzido (cancelamento não é falha). */
export function useGuard(): Guard {
  const pushNotice = useAppStore((s) => s.pushNotice)
  return useCallback(
    async (action) => {
      try {
        await action()
        return true
      } catch (error) {
        const info = errorInfoOf(error)
        if (info.code !== 'CANCELED') {
          pushNotice({ kind: 'error', key: `errors.${info.code}`, error: info })
        }
        return false
      }
    },
    [pushNotice]
  )
}
