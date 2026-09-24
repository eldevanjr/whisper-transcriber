import { useEffect, useState } from 'react'
import type { HistoryMeta } from '../../../shared/history'
import type { HistoryDetail } from '../../../shared/ipc'
import { useApi } from '../providers'

/** Detalhe do item selecionado; recarrega quando o status ou a versão (ao vivo) mudam. */
export function useEntryDetail(meta: HistoryMeta | undefined): HistoryDetail | null {
  const api = useApi()
  const [detail, setDetail] = useState<{ id: string; value: HistoryDetail } | null>(null)
  const id = meta?.id
  const status = meta?.status
  const version = meta?.activeVersion

  useEffect(() => {
    if (id === undefined) return
    let active = true
    api.history
      .get(id)
      .then((value) => {
        if (active) setDetail({ id, value })
      })
      .catch(() => undefined) // entrada ilegível: a tela segue só com o meta
    return () => {
      active = false
    }
  }, [api, id, status, version])

  return detail !== null && detail.id === id ? detail.value : null
}
