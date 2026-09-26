import { useEffect, useEffectEvent } from 'react'
import type { NavigateTarget } from '../../../shared/ipc'
import { useApi, useAppStore, useAppStoreApi } from '../providers'

/** Clique numa notificação: o main mostra a janela e pede a tela certa. */
export function useBackgroundNavigation(): void {
  const api = useApi()
  const select = useAppStore((s) => s.select)
  const openLive = useAppStore((s) => s.openLive)
  const closeLive = useAppStore((s) => s.closeLive)
  const store = useAppStoreApi()
  const onNavigate = useEffectEvent((target: NavigateTarget) => {
    if (target.kind === 'live') openLive()
    if (target.kind !== 'item') return
    select(target.id)
    if (store.getState().liveSession.state === 'idle') closeLive() // com sessão em andamento a tela dela continua
  })
  useEffect(() => api.background.onNavigate(onNavigate), [api])
}
