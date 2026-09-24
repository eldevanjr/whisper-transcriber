import { vi } from 'vitest'
import type {
  Capture,
  CaptureEvent,
  CaptureOptions,
  LiveMedia
} from '../../src/renderer/src/live/capture'
import type { InputDevice } from '../../src/renderer/src/live/devices'
import type { Track } from '../../src/shared/settings'

export class FakeCapture implements Capture {
  stopped = false
  private readonly listeners = new Set<(event: CaptureEvent) => void>()

  constructor(
    readonly options: CaptureOptions,
    readonly tracks: Track[]
  ) {}

  onEvent(callback: (event: CaptureEvent) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  emit(event: CaptureEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  /** Bloco de 100 ms com o nível dado. */
  block(track: Track, seq: number, rms: number): Int16Array {
    const pcm = new Int16Array(4800)
    this.emit({ type: 'block', track, seq, pcm, rms })
    return pcm
  }

  stop = vi.fn(() => {
    this.stopped = true
    return Promise.resolve()
  })
}

/** Captura em memória: guarda cada abertura para o teste inspecionar e emitir blocos. */
export class FakeLiveMedia implements LiveMedia {
  captures: FakeCapture[] = []
  inputs: InputDevice[] = [
    { id: 'mic1', label: 'Microfone USB', monitor: false },
    { id: 'mon', label: 'Monitor of Alto-falantes', monitor: true }
  ]
  failure: unknown = null
  /** false: o áudio do sistema foi pedido mas não veio (loopback recusado, sem monitor). */
  systemWorks = true

  start = vi.fn((options: CaptureOptions): Promise<Capture> => {
    if (this.failure) return Promise.reject(this.failure)
    const tracks: Track[] =
      options.systemAudio && options.support !== 'unavailable' && this.systemWorks
        ? ['voce', 'outros']
        : ['voce']
    const capture = new FakeCapture(options, tracks)
    this.captures.push(capture)
    return Promise.resolve(capture)
  })

  devices = vi.fn(() => Promise.resolve(this.inputs))

  get last(): FakeCapture {
    const capture = this.captures.at(-1)
    if (!capture) throw new Error('nenhuma captura aberta')
    return capture
  }
}
