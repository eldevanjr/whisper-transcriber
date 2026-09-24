import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../../src/shared/errors'
import {
  startCapture,
  type CaptureDeps,
  type CaptureEvent
} from '../../../src/renderer/src/live/capture'

class FakeTrack extends EventTarget {
  stopped = false
  constructor(readonly kind: 'audio' | 'video') {
    super()
  }
  stop(): void {
    this.stopped = true
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === 'video')
  }
  removeTrack(track: FakeTrack): void {
    this.tracks.splice(this.tracks.indexOf(track), 1)
  }
}

interface FakeNode {
  stream: FakeStream
  onBlock: (block: { pcm: Int16Array; rms: number }) => void
  disconnected: boolean
}

function setup(
  options: { devices?: MediaDeviceInfo[]; deny?: boolean; display?: FakeStream | Error } = {}
) {
  const nodes: FakeNode[] = []
  const context = {
    closed: false,
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    close: vi.fn(() => {
      context.closed = true
      return Promise.resolve()
    })
  }
  const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<FakeStream>>(() => {
    if (options.deny) return Promise.reject(new DOMException('no', 'NotAllowedError'))
    return Promise.resolve(new FakeStream([new FakeTrack('audio')]))
  })
  const getDisplayMedia = vi.fn(() => {
    const display =
      options.display ?? new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
    return display instanceof Error ? Promise.reject(display) : Promise.resolve(display)
  })
  const deps = {
    media: {
      getUserMedia,
      getDisplayMedia,
      enumerateDevices: () => Promise.resolve(options.devices ?? [])
    },
    createContext: vi.fn(() => context),
    connect: vi.fn((_ctx: unknown, stream: FakeStream, onBlock: FakeNode['onBlock']) => {
      const node: FakeNode = { stream, onBlock, disconnected: false }
      nodes.push(node)
      return {
        disconnect: () => {
          node.disconnected = true
        }
      }
    }),
    workletUrl: 'blob:worklet'
  } as unknown as CaptureDeps
  return { deps, nodes, context, getUserMedia, getDisplayMedia }
}

const monitor = {
  kind: 'audioinput',
  deviceId: 'mon',
  label: 'Monitor of Alto-falantes'
} as MediaDeviceInfo

describe('startCapture', () => {
  it('microfone escolhido vai ao getUserMedia com eco cancelado', async () => {
    const { deps, getUserMedia, context } = setup()
    const capture = await startCapture(
      { micDeviceId: 'mic1', systemAudio: false, support: 'loopback' },
      deps
    )
    expect(capture.tracks).toEqual(['voce'])
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic1' },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith('blob:worklet')
  })

  it('sem microfone escolhido usa o padrão do sistema', async () => {
    const { deps, getUserMedia } = setup()
    await startCapture({ micDeviceId: null, systemAudio: false, support: 'loopback' }, deps)
    expect(getUserMedia.mock.calls[0]![0]).toMatchObject({ audio: { deviceId: undefined } })
  })

  it('blocos do worklet saem numerados por faixa, com o nível', async () => {
    const { deps, nodes } = setup()
    const capture = await startCapture(
      { micDeviceId: null, systemAudio: false, support: 'unavailable' },
      deps
    )
    const events: CaptureEvent[] = []
    capture.onEvent((e) => events.push(e))
    const pcm = new Int16Array(4800)
    nodes[0]!.onBlock({ pcm, rms: 0.2 })
    nodes[0]!.onBlock({ pcm, rms: 0.3 })
    expect(events).toEqual([
      { type: 'block', track: 'voce', seq: 0, pcm, rms: 0.2 },
      { type: 'block', track: 'voce', seq: 1, pcm, rms: 0.3 }
    ])
  })

  it('Windows/macOS: o áudio do sistema vem do loopback e o vídeo é descartado', async () => {
    const display = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
    const video = display.tracks[0]!
    const { deps, nodes } = setup({ display })
    const capture = await startCapture(
      { micDeviceId: null, systemAudio: true, support: 'loopback' },
      deps
    )
    expect(capture.tracks).toEqual(['voce', 'outros'])
    expect(video.stopped).toBe(true)
    expect(nodes[1]!.stream.getVideoTracks()).toEqual([])
  })

  it('Linux: o áudio do sistema vem do monitor, sem eco cancelado', async () => {
    const { deps, getUserMedia, getDisplayMedia } = setup({ devices: [monitor] })
    const capture = await startCapture(
      { micDeviceId: null, systemAudio: true, support: 'monitor' },
      deps
    )
    expect(capture.tracks).toEqual(['voce', 'outros'])
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(getUserMedia.mock.calls[1]![0]).toEqual({
      audio: {
        deviceId: { exact: 'mon' },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
  })

  it('Linux sem monitor, sistema sem suporte ou loopback recusado: só o microfone', async () => {
    for (const [support, extra] of [
      ['monitor', {}],
      ['unavailable', {}],
      ['loopback', { display: new Error('cancelado') }],
      ['loopback', { display: new FakeStream([new FakeTrack('video')]) }]
    ] as const) {
      const { deps } = setup(extra)
      const capture = await startCapture({ micDeviceId: null, systemAudio: true, support }, deps)
      expect(capture.tracks).toEqual(['voce'])
    }
  })

  it('permissão do microfone negada vira MIC_DENIED', async () => {
    const { deps } = setup({ deny: true })
    const error = await startCapture(
      { micDeviceId: null, systemAudio: false, support: 'loopback' },
      deps
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('MIC_DENIED')
  })

  it('outra falha do microfone é repassada e fecha o contexto', async () => {
    const { deps, context, getUserMedia } = setup()
    getUserMedia.mockRejectedValueOnce(new DOMException('x', 'NotFoundError'))
    await expect(
      startCapture({ micDeviceId: 'x', systemAudio: false, support: 'loopback' }, deps)
    ).rejects.toThrow('x')
    expect(context.closed).toBe(true)
  })

  it('falha no monitor depois do microfone solta o microfone', async () => {
    const { deps, context, getUserMedia } = setup({ devices: [monitor] })
    const mic = new FakeStream([new FakeTrack('audio')])
    getUserMedia.mockResolvedValueOnce(mic).mockRejectedValueOnce(new Error('monitor sumiu'))
    await expect(
      startCapture({ micDeviceId: null, systemAudio: true, support: 'monitor' }, deps)
    ).rejects.toThrow('monitor sumiu')
    expect(mic.tracks[0]!.stopped).toBe(true)
    expect(context.closed).toBe(true)
  })

  it('dispositivo desconectado avisa device-lost', async () => {
    const { deps, nodes } = setup()
    const capture = await startCapture(
      { micDeviceId: null, systemAudio: false, support: 'loopback' },
      deps
    )
    const events: CaptureEvent[] = []
    const off = capture.onEvent((e) => events.push(e))
    nodes[0]!.stream.tracks[0]!.dispatchEvent(new Event('ended'))
    expect(events).toEqual([{ type: 'device-lost', track: 'voce' }])
    off()
    nodes[0]!.stream.tracks[0]!.dispatchEvent(new Event('ended'))
    expect(events).toHaveLength(1)
  })

  it('stop solta os dispositivos e fecha o contexto', async () => {
    const { deps, nodes, context } = setup({ devices: [monitor] })
    const capture = await startCapture(
      { micDeviceId: null, systemAudio: true, support: 'monitor' },
      deps
    )
    await capture.stop()
    expect(nodes.every((n) => n.disconnected)).toBe(true)
    expect(nodes.flatMap((n) => n.stream.tracks).every((t) => t.stopped)).toBe(true)
    expect(context.closed).toBe(true)
  })
})
