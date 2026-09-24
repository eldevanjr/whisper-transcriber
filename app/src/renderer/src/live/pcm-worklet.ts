// Roda na thread de áudio (AudioWorkletGlobalScope): só repassa os quadros ao PcmChunker, que é
// testado à parte. Fica fora da cobertura porque o jsdom não tem AudioWorklet.
import { PcmChunker } from './chunker'

declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: unknown): void

class PcmCapture extends AudioWorkletProcessor {
  private readonly chunker = new PcmChunker()

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (channel) {
      for (const block of this.chunker.push(channel)) {
        this.port.postMessage(block, [block.pcm.buffer])
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
