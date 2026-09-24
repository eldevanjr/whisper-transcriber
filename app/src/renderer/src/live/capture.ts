import { AppError } from '../../../shared/errors'
import type { LiveCapabilities } from '../../../shared/ipc'
import type { Track } from '../../../shared/settings'
import type { PcmBlock } from './chunker'
import { findMonitor, listInputDevices } from './devices'

export const WORKLET_NAME = 'pcm-capture'

export type CaptureEvent =
  | { type: 'block'; track: Track; seq: number; pcm: Int16Array; rms: number }
  /** A faixa acabou sozinha (microfone desconectado, compartilhamento encerrado). */
  | { type: 'device-lost'; track: Track }

export interface Capture {
  /** Faixas que de fato estão gravando (o áudio do sistema pode não estar disponível). */
  tracks: Track[]
  onEvent(callback: (event: CaptureEvent) => void): () => void
  stop(): Promise<void>
}

export interface CaptureOptions {
  micDeviceId: string | null
  systemAudio: boolean
  support: LiveCapabilities['systemAudio']
}

interface ContextLike {
  audioWorklet: { addModule(url: string): Promise<void> }
  close(): Promise<void>
}

export interface CaptureDeps {
  media: Pick<MediaDevices, 'getUserMedia' | 'getDisplayMedia' | 'enumerateDevices'>
  createContext(): ContextLike
  /** Liga o stream ao worklet, que devolve blocos de 100 ms; devolve como desligar. */
  connect(
    context: ContextLike,
    stream: MediaStream,
    onBlock: (block: PcmBlock) => void
  ): { disconnect(): void }
  workletUrl: string
}

const MIC_PROCESSING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

function audioConstraints(deviceId: string | null, processing: typeof RAW): MediaStreamConstraints {
  return {
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, ...processing }
  }
}

export async function startCapture(options: CaptureOptions, deps: CaptureDeps): Promise<Capture> {
  const context = deps.createContext()
  const streams = new Map<Track, MediaStream>()
  try {
    await context.audioWorklet.addModule(deps.workletUrl)
    streams.set('voce', await openMic(deps, options.micDeviceId))
    const system = options.systemAudio ? await openSystem(deps, options.support) : null
    if (system) streams.set('outros', system)
  } catch (error) {
    for (const stream of streams.values()) stopStream(stream)
    await context.close()
    throw error
  }
  return wire(context, streams, deps)
}

async function openMic(deps: CaptureDeps, deviceId: string | null): Promise<MediaStream> {
  try {
    return await deps.media.getUserMedia(audioConstraints(deviceId, MIC_PROCESSING))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new AppError('MIC_DENIED', 'Acesso ao microfone negado')
    }
    throw error
  }
}

/** Áudio do sistema quando o sistema operacional permite; senão a sessão segue só com o microfone. */
async function openSystem(
  deps: CaptureDeps,
  support: CaptureOptions['support']
): Promise<MediaStream | null> {
  if (support === 'monitor') {
    const monitor = findMonitor(await listInputDevices(deps.media))
    return monitor ? deps.media.getUserMedia(audioConstraints(monitor, RAW)) : null
  }
  if (support !== 'loopback') return null
  try {
    const stream = await deps.media.getDisplayMedia({ video: true, audio: true })
    for (const video of stream.getVideoTracks()) {
      video.stop()
      stream.removeTrack(video)
    }
    return stream.getAudioTracks().length > 0 ? stream : null
  } catch {
    return null
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function wire(context: ContextLike, streams: Map<Track, MediaStream>, deps: CaptureDeps): Capture {
  const listeners = new Set<(event: CaptureEvent) => void>()
  const emit = (event: CaptureEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const links = [...streams].map(([track, stream]) => {
    let seq = 0
    const link = deps.connect(context, stream, ({ pcm, rms }) => {
      emit({ type: 'block', track, seq, pcm, rms })
      seq += 1
    })
    for (const media of stream.getAudioTracks()) {
      media.addEventListener('ended', () => {
        emit({ type: 'device-lost', track })
      })
    }
    return link
  })
  return {
    tracks: [...streams.keys()],
    onEvent(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    async stop() {
      for (const link of links) link.disconnect()
      for (const stream of streams.values()) stopStream(stream)
      await context.close()
    }
  }
}
