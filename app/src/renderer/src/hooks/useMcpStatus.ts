import { useCallback, useEffect, useState } from 'react'
import type { McpStatus } from '../../../shared/ipc'
import type { ClientStatusError, McpActivityLine, McpClientId } from '../../../shared/mcp'
import { errorInfoOf } from '../errors'
import { useApi } from '../providers'

export type McpTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; tools: number }
  | { status: 'error'; error: ClientStatusError }

/** Retrato e ações da seção "IAs (MCP)": recarrega ao abrir e depois de cada ação. */
export interface McpStatusController {
  status: McpStatus | null
  activity: McpActivityLine[]
  busy: McpClientId | null
  errors: Partial<Record<McpClientId, ClientStatusError>>
  test: McpTestState
  reload: () => Promise<void>
  connect: (id: McpClientId) => Promise<void>
  disconnect: (id: McpClientId) => Promise<void>
  runTest: () => Promise<void>
}

export function useMcpStatus(): McpStatusController {
  const api = useApi()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [activity, setActivity] = useState<McpActivityLine[]>([])
  const [busy, setBusy] = useState<McpClientId | null>(null)
  const [errors, setErrors] = useState<Partial<Record<McpClientId, ClientStatusError>>>({})
  const [test, setTest] = useState<McpTestState>({ status: 'idle' })

  const reload = useCallback(async () => {
    try {
      const [next, lines] = await Promise.all([api.mcpStatus(), api.mcpActivity()])
      setStatus(next)
      setActivity(lines)
    } catch {
      // Mantém o retrato anterior; a próxima abertura tenta de novo.
    }
  }, [api])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = useCallback(
    async (id: McpClientId, action: () => Promise<unknown>): Promise<void> => {
      setBusy(id)
      try {
        await action()
        setErrors((previous) => ({ ...previous, [id]: undefined }))
      } catch (error) {
        setErrors((previous) => ({ ...previous, [id]: errorInfoOf(error) }))
      } finally {
        setBusy(null)
        await reload()
      }
    },
    [reload]
  )

  const connect = useCallback((id: McpClientId) => run(id, () => api.mcpConnect(id)), [api, run])
  const disconnect = useCallback(
    (id: McpClientId) => run(id, () => api.mcpDisconnect(id)),
    [api, run]
  )

  const runTest = useCallback(async () => {
    setTest({ status: 'testing' })
    try {
      const result = await api.mcpTest()
      setTest({ status: 'ok', tools: result.tools })
    } catch (error) {
      setTest({ status: 'error', error: errorInfoOf(error) })
    } finally {
      await reload()
    }
  }, [api, reload])

  return { status, activity, busy, errors, test, reload, connect, disconnect, runTest }
}
