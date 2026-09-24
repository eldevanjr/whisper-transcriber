import { describe, expect, it, vi } from 'vitest'
import {
  allowPermission,
  displayMediaHandler,
  systemAudioSupport
} from '../../../src/main/live/system-audio'

describe('systemAudioSupport', () => {
  it.each([
    ['win32', '10.0.22631', 'loopback'],
    ['darwin', '23.2.0', 'loopback'], // macOS 14.2
    ['darwin', '24.1.0', 'loopback'],
    ['darwin', '23.1.0', 'unavailable'], // macOS 14.1: sem captura de áudio do sistema
    ['linux', '6.14.0-35-generic', 'loopback'],
    ['freebsd', '14.0', 'unavailable']
  ])('%s %s → %s', (platform, release, expected) => {
    expect(systemAudioSupport(platform, release)).toBe(expected)
  })
})

describe('displayMediaHandler', () => {
  it('entrega a tela (vídeo descartado depois) com o áudio do sistema, sem seletor', async () => {
    const screen = { id: 'screen:0', name: 'Tela' }
    const getSources = vi.fn(() => Promise.resolve([screen]))
    const callback = vi.fn()
    await displayMediaHandler(getSources)({}, callback)
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'] })
    expect(callback).toHaveBeenCalledWith({ video: screen, audio: 'loopback' })
  })

  it('sem tela disponível ou erro: recusa', async () => {
    const callback = vi.fn()
    await displayMediaHandler(() => Promise.resolve([]))({}, callback)
    await displayMediaHandler(() => Promise.reject(new Error('x')))({}, callback)
    expect(callback.mock.calls).toEqual([[{}], [{}]])
  })
})

describe('allowPermission', () => {
  it('só microfone (áudio) e captura de tela para o áudio do sistema', () => {
    expect(allowPermission('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(allowPermission('media', { mediaTypes: ['audio', 'video'] })).toBe(false) // câmera não
    expect(allowPermission('media', {})).toBe(false)
    expect(allowPermission('media', { mediaTypes: [] })).toBe(true) // getDisplayMedia
    // verificação (setPermissionCheckHandler) manda o tipo no singular
    expect(allowPermission('media', { mediaType: 'audio' })).toBe(true)
    expect(allowPermission('media', { mediaType: 'video' })).toBe(false)
    expect(allowPermission('display-capture', {})).toBe(true)
    for (const other of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'hid']) {
      expect(allowPermission(other, {})).toBe(false)
    }
  })
})
