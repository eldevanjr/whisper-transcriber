import { describe, expect, it } from 'vitest'
import { BLOCK_SAMPLES, PcmChunker } from '../../../src/renderer/src/live/chunker'

describe('PcmChunker', () => {
  it('junta quadros do AudioWorklet (128) em blocos de 100 ms (4800) em PCM16', () => {
    const chunker = new PcmChunker()
    const blocks = []
    for (let i = 0; i < 80; i += 1) blocks.push(...chunker.push(new Float32Array(128).fill(0.5)))
    expect(BLOCK_SAMPLES).toBe(4800)
    expect(blocks).toHaveLength(2) // 80 × 128 = 10 240 → 2 blocos e sobra
    expect(blocks[0]!.pcm).toHaveLength(4800)
    expect(blocks[0]!.pcm[0]).toBe(16384) // 0,5 × 32768
    expect(blocks[0]!.rms).toBeCloseTo(0.5)
  })

  it('satura em ±1 sem estourar o PCM16', () => {
    const [block] = new PcmChunker().push(
      Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? 2 : -2))
    )
    expect(block!.pcm[0]).toBe(-32768)
    expect(block!.pcm[1]).toBe(32767)
  })
})
