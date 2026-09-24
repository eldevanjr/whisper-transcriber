export interface InputDevice {
  id: string
  label: string
  /** Monitor do PipeWire/PulseAudio: o áudio do sistema no Linux, não um microfone. */
  monitor: boolean
}

type Enumerate = Pick<MediaDevices, 'enumerateDevices'>

const MONITOR = /^monitor of /i

export async function listInputDevices(media: Enumerate): Promise<InputDevice[]> {
  const devices = await media.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ id: d.deviceId, label: d.label, monitor: MONITOR.test(d.label) }))
}

export function findMonitor(devices: InputDevice[]): string | null {
  return devices.find((d) => d.monitor)?.id ?? null
}
