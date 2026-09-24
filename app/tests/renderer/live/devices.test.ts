import { describe, expect, it, vi } from 'vitest'
import { findMonitor, listInputDevices } from '../../../src/renderer/src/live/devices'

describe('dispositivos de entrada', () => {
  it('lista só entradas de áudio e marca os monitores (áudio do sistema no Linux)', async () => {
    const enumerateDevices = vi.fn(() =>
      Promise.resolve([
        { kind: 'audioinput', deviceId: 'default', label: 'Padrão' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Microfone interno' },
        { kind: 'audioinput', deviceId: 'mon', label: 'Monitor of Alto-falantes' },
        { kind: 'videoinput', deviceId: 'cam', label: 'Câmera' },
        { kind: 'audiooutput', deviceId: 'out', label: 'Alto-falantes' }
      ] as MediaDeviceInfo[])
    )
    const devices = await listInputDevices({ enumerateDevices })
    expect(devices).toEqual([
      { id: 'default', label: 'Padrão', monitor: false },
      { id: 'mic1', label: 'Microfone interno', monitor: false },
      { id: 'mon', label: 'Monitor of Alto-falantes', monitor: true }
    ])
    expect(findMonitor(devices)).toBe('mon')
    expect(findMonitor(devices.filter((d) => !d.monitor))).toBeNull()
  })

  it('dispositivo sem nome (antes da permissão) fica sem rótulo: a tela põe um genérico', async () => {
    const devices = await listInputDevices({
      enumerateDevices: () =>
        Promise.resolve([{ kind: 'audioinput', deviceId: 'x', label: '' }] as MediaDeviceInfo[])
    })
    expect(devices).toEqual([{ id: 'x', label: '', monitor: false }])
  })
})
