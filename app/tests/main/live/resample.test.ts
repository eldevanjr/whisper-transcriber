import { describe, expect, it } from 'vitest'
import { Downsampler } from '../../../src/main/live/resample'

const tone = (freq: number, samples: number, rate = 48000, amp = 10000) =>
  Int16Array.from({ length: samples }, (_, i) =>
    Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate))
  )

const rms = (data: Int16Array) => Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length)

describe('Downsampler 48 → 16 kHz', () => {
  it('um terço das amostras, em blocos de qualquer tamanho, sem perder a sobra', () => {
    const down = new Downsampler()
    const outs = [
      down.push(new Int16Array(4800)),
      down.push(new Int16Array(100)),
      down.push(new Int16Array(200))
    ]
    expect(outs.map((o) => o.length)).toEqual([1600, 33, 67])
  })

  it('mantém a voz (1 kHz) e corta o que o Whisper não usa (acima de 8 kHz)', () => {
    const voice = new Downsampler().push(tone(1000, 48000))
    const hiss = new Downsampler().push(tone(12000, 48000))
    expect(rms(voice.subarray(100))).toBeGreaterThan(6000) // ~7071 esperado
    expect(rms(hiss.subarray(100))).toBeLessThan(700) // atenuado (sem virar ruído "dobrado")
  })

  it('estado entre blocos: dividir o sinal não muda o resultado', () => {
    const signal = tone(440, 9600)
    const whole = new Downsampler().push(signal)
    const split = new Downsampler()
    const parts = [split.push(signal.subarray(0, 1234)), split.push(signal.subarray(1234))]
    const joined = Int16Array.from([...parts[0]!, ...parts[1]!])
    expect(joined).toEqual(whole)
  })
})
