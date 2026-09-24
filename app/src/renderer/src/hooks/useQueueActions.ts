import { useMemo } from 'react'
import { fileNameOf } from '../../../shared/media'
import { useApi, useAppStore } from '../providers'
import { useGuard } from './useGuard'

export interface QueueActions {
  enqueue: (paths: string[]) => Promise<void>
  chooseAndEnqueue: () => Promise<void>
  removeFromQueue: (id: string) => Promise<void>
  retry: (id: string) => Promise<void>
  locate: (id: string) => Promise<void>
  deleteEntry: (id: string) => Promise<void>
  cancel: () => Promise<void>
}

/** Ações da fila e do histórico; toda falha vira um aviso traduzido. */
export function useQueueActions(): QueueActions {
  const api = useApi()
  const pushNotice = useAppStore((s) => s.pushNotice)
  const guard = useGuard()

  return useMemo(() => {
    const run = async (action: () => Promise<unknown>): Promise<void> => {
      await guard(action)
    }
    const enqueue = (paths: string[]): Promise<void> =>
      run(async () => {
        const { rejected } = await api.queue.enqueue(paths)
        if (rejected.length === 0) return
        const names = rejected.map(fileNameOf).join(', ')
        pushNotice({ kind: 'error', key: 'notices.rejected', values: { names } })
      })
    return {
      enqueue,
      chooseAndEnqueue: () =>
        run(async () => {
          const paths = await api.files.choose()
          if (paths.length > 0) await enqueue(paths)
        }),
      removeFromQueue: (id) => run(() => api.queue.remove(id)),
      retry: (id) => run(() => api.queue.retry(id)),
      locate: (id) =>
        run(async () => {
          const [path] = await api.files.choose()
          if (path !== undefined) await api.queue.retry(id, path)
        }),
      deleteEntry: (id) => run(() => api.history.remove(id)),
      cancel: () => run(() => api.queue.cancel())
    }
  }, [api, guard, pushNotice])
}
