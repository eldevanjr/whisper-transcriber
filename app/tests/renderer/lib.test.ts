import { describe, expect, it } from 'vitest'
import { acceleratorFromKeys } from '../../src/renderer/src/lib/accelerator'
import { formatBytes } from '../../src/renderer/src/lib/bytes'
import { transferRate, type Sample } from '../../src/renderer/src/lib/rate'

describe('formatBytes', () => {
  it('GB com uma casa a partir de 1 GB, MB inteiros abaixo, no formato do idioma', () => {
    expect(formatBytes(1_530_000_000, 'pt-BR')).toBe('1,5 GB')
    expect(formatBytes(1_530_000_000, 'en')).toBe('1.5 GB')
    expect(formatBytes(484_000_000, 'es')).toBe('484 MB')
    expect(formatBytes(0, 'en')).toBe('0 MB')
  })
})

describe('transferRate', () => {
  const s = (t: number, bytes: number): Sample => ({ t, bytes })

  it('média dos últimos 3 s em bytes por segundo', () => {
    expect(transferRate([s(0, 0), s(1000, 100), s(2000, 300)])).toBe(150)
    expect(transferRate([s(0, 0), s(1000, 5000), s(4000, 8000), s(5000, 9000)])).toBe(1000)
  })

  it('sem amostras suficientes, zero', () => {
    expect(transferRate([])).toBe(0)
    expect(transferRate([s(0, 10)])).toBe(0)
    expect(transferRate([s(10, 10), s(10, 20)])).toBe(0)
  })
})

describe('acceleratorFromKeys', () => {
  const keys = (
    code: string,
    mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
    key = 'x'
  ) => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods
  })

  it('Windows/Linux: Ctrl vira CommandOrControl, Meta vira Super', () => {
    expect(acceleratorFromKeys(keys('KeyR', { ctrlKey: true, altKey: true }), 'linux')).toBe(
      'CommandOrControl+Alt+R'
    )
    expect(acceleratorFromKeys(keys('Digit5', { metaKey: true, shiftKey: true }), 'win32')).toBe(
      'Super+Shift+5'
    )
    expect(acceleratorFromKeys(keys('F9', { altKey: true }), 'linux')).toBe('Alt+F9')
    expect(acceleratorFromKeys(keys('Space', { ctrlKey: true }), 'linux')).toBe(
      'CommandOrControl+Space'
    )
  })

  it('macOS: ⌘ vira CommandOrControl, ⌃ vira Control', () => {
    expect(acceleratorFromKeys(keys('KeyR', { metaKey: true, altKey: true }), 'darwin')).toBe(
      'CommandOrControl+Alt+R'
    )
    expect(acceleratorFromKeys(keys('KeyR', { ctrlKey: true }), 'darwin')).toBe('Control+R')
  })

  it('só modificador: esperando; sem modificador (ou só Shift) ou tecla estranha: inválido', () => {
    expect(acceleratorFromKeys(keys('AltLeft', { altKey: true }, 'Alt'), 'linux')).toBe('pending')
    expect(acceleratorFromKeys(keys('KeyR'), 'linux')).toBeNull()
    expect(acceleratorFromKeys(keys('KeyR', { shiftKey: true }), 'linux')).toBeNull()
    expect(acceleratorFromKeys(keys('Semicolon', { ctrlKey: true }), 'linux')).toBeNull()
  })
})

describe('apiLabel', () => {
  it('Metal na Apple, Vulkan no resto', async () => {
    const { apiLabel } = await import('../../src/renderer/src/lib/gpu')
    expect(apiLabel({ name: 'Apple M2', api: 'metal' })).toBe('Metal')
    expect(apiLabel({ name: 'Intel', api: 'vulkan' })).toBe('Vulkan')
  })
})
