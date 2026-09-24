export const CAPTURE_RATE = 48000
export const BLOCK_SAMPLES = 4800 // 100 ms a 48 kHz: o bloco que vai para o main

export interface PcmBlock {
  pcm: Int16Array
  /** Nível do bloco (RMS de 0 a 1), para o medidor da tela. */
  rms: number
}

/** Junta os quadros do AudioWorklet (128 amostras float) em blocos de 100 ms em PCM16. */
export class PcmChunker {
  private buffer = new Float32Array(BLOCK_SAMPLES)
  private filled = 0

  push(frame: Float32Array): PcmBlock[] {
    const blocks: PcmBlock[] = []
    let offset = 0
    while (offset < frame.length) {
      const take = Math.min(BLOCK_SAMPLES - this.filled, frame.length - offset)
      this.buffer.set(frame.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === BLOCK_SAMPLES) {
        blocks.push(toBlock(this.buffer))
        this.filled = 0
      }
    }
    return blocks
  }
}

function toBlock(samples: Float32Array): PcmBlock {
  const pcm = new Int16Array(samples.length)
  let sum = 0
  for (const [i, sample] of samples.entries()) {
    const value = Math.max(-1, Math.min(1, sample))
    pcm[i] = value < 0 ? value * 32768 : Math.min(32767, value * 32768)
    sum += value * value
  }
  return { pcm, rms: Math.sqrt(sum / samples.length) }
}
