// APIs reais do navegador para a captura (o jsdom não tem AudioContext): fora da cobertura.
import { CAPTURE_RATE, type PcmBlock } from './chunker'
import { startCapture, WORKLET_NAME, type CaptureDeps, type LiveMedia } from './capture'
import { listInputDevices } from './devices'
import workletUrl from './pcm-worklet?worker&url'

export function browserCaptureDeps(): CaptureDeps {
  return {
    media: navigator.mediaDevices,
    createContext: () => new AudioContext({ sampleRate: CAPTURE_RATE }),
    connect(context, stream, onBlock) {
      const audio = context as AudioContext
      const source = audio.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(audio, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit' // loopback estéreo vira mono
      })
      node.port.onmessage = (event: MessageEvent<PcmBlock>) => {
        onBlock(event.data)
      }
      source.connect(node)
      return {
        disconnect() {
          source.disconnect()
          node.disconnect()
        }
      }
    },
    workletUrl
  }
}

export function browserLiveMedia(): LiveMedia {
  return {
    start: (options) => startCapture(options, browserCaptureDeps()),
    devices: () => listInputDevices(navigator.mediaDevices)
  }
}
