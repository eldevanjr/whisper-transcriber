/**
 * 48 kHz → 16 kHz para o worker: passa-baixa FIR (sinc janelado, corte em 7 kHz) e uma amostra
 * a cada três. O estado (histórico do filtro e a fase) passa de um bloco para o outro.
 */
const FACTOR = 3
const TAPS = 63
const CUTOFF = 7000 / 48000

function lowPass(): Float64Array {
  const taps = new Float64Array(TAPS)
  const mid = (TAPS - 1) / 2
  for (let k = 0; k < TAPS; k += 1) {
    const x = k - mid
    const sinc = x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x)
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (TAPS - 1))
    taps[k] = sinc * hamming
  }
  const sum = taps.reduce((a, b) => a + b, 0)
  return taps.map((t) => t / sum)
}

const FILTER = lowPass()

export class Downsampler {
  private history = new Float64Array(TAPS - 1)
  private phase = 0

  push(input: Int16Array): Int16Array {
    const data = new Float64Array(this.history.length + input.length)
    data.set(this.history)
    data.set(input, this.history.length)
    const out: number[] = []
    for (let i = this.history.length; i < data.length; i += 1) {
      this.phase += 1
      if (this.phase === FACTOR) {
        this.phase = 0
        out.push(this.filterAt(data, i))
      }
    }
    this.history = data.slice(data.length - (TAPS - 1))
    return Int16Array.from(out, (v) => Math.max(-32768, Math.min(32767, Math.round(v))))
  }

  private filterAt(data: Float64Array, index: number): number {
    // O índice sempre existe (o histórico cobre os TAPS - 1 anteriores).
    return FILTER.reduce((acc, tap, k) => acc + tap * Number(data[index - k]), 0)
  }
}
