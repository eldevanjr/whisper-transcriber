import { describe, expect, it } from 'vitest'
import { LOW_RAM_BYTES, MODEL_CATALOG, MODEL_IDS, recommendModel } from '../../src/shared/models'

describe('models', () => {
  it('tem um item de catálogo por modelo', () => {
    expect(Object.keys(MODEL_CATALOG)).toEqual([...MODEL_IDS])
    for (const id of MODEL_IDS) expect(MODEL_CATALOG[id].id).toBe(id)
  })

  it('recomenda Small com pouca RAM, mesmo com GPU', () => {
    expect(recommendModel({ ramBytes: LOW_RAM_BYTES - 1, hasNvidiaGpu: true })).toBe('small')
  })

  it('recomenda Large v3 Turbo com GPU NVIDIA', () => {
    expect(recommendModel({ ramBytes: LOW_RAM_BYTES, hasNvidiaGpu: true })).toBe('large-v3-turbo')
  })

  it('recomenda Medium no caso comum', () => {
    expect(recommendModel({ ramBytes: 16 * 1024 ** 3, hasNvidiaGpu: false })).toBe('medium')
  })
})

describe('formatForDevice', () => {
  it('só a GPU do whisper.cpp usa GGML', async () => {
    const { formatForDevice } = await import('../../src/shared/models')
    expect(formatForDevice('gpu')).toBe('ggml')
    expect(formatForDevice('cuda')).toBe('ct2')
    expect(formatForDevice('cpu')).toBe('ct2')
  })
})

describe('downloadKey', () => {
  it('chave distinta por formato', async () => {
    const { downloadKey } = await import('../../src/shared/events')
    expect(downloadKey({ kind: 'cuda' })).toBe('cuda')
    expect(downloadKey({ kind: 'model', id: 'small' })).toBe('model:small')
    expect(downloadKey({ kind: 'model', id: 'small', format: 'ct2' })).toBe('model:small')
    expect(downloadKey({ kind: 'model', id: 'small', format: 'ggml' })).toBe('model-ggml:small')
  })
})
