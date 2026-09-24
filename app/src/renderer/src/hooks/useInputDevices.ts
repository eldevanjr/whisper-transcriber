import { useEffect, useState } from 'react'
import type { InputDevice } from '../live/devices'
import { useLiveMedia } from '../providers'

/**
 * Entradas de áudio do sistema. Os nomes só aparecem depois da permissão do microfone: `version`
 * muda quando a captura abre, para listar de novo.
 */
export function useInputDevices(version: unknown = null): InputDevice[] {
  const media = useLiveMedia()
  const [devices, setDevices] = useState<InputDevice[]>([])
  useEffect(() => {
    let active = true
    void media.devices().then((found) => {
      if (active) setDevices(found)
    })
    return () => {
      active = false
    }
  }, [media, version])
  return devices
}
