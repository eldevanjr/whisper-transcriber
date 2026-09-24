import { describe, expect, it } from 'vitest'
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

describe('apiLabel', () => {
  it('Metal na Apple, Vulkan no resto', async () => {
    const { apiLabel } = await import('../../src/renderer/src/lib/gpu')
    expect(apiLabel({ name: 'Apple M2', api: 'metal' })).toBe('Metal')
    expect(apiLabel({ name: 'Intel', api: 'vulkan' })).toBe('Vulkan')
  })
})
