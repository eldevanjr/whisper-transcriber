import { useEffect, useState } from 'react'
import type { LiveCapabilities } from '../../../shared/ipc'
import { useApi } from '../providers'

export type SystemAudioSupport = LiveCapabilities['systemAudio']

/** Se este sistema captura o áudio do computador (null enquanto pergunta ao main). */
export function useLiveSupport(): SystemAudioSupport | null {
  const api = useApi()
  const [support, setSupport] = useState<SystemAudioSupport | null>(null)
  useEffect(() => {
    let active = true
    void api.live.capabilities().then((capabilities) => {
      if (active) setSupport(capabilities.systemAudio)
    })
    return () => {
      active = false
    }
  }, [api])
  return support
}
