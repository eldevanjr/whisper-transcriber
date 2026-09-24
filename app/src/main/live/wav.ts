import { open, type FileHandle } from 'node:fs/promises'

export const RECORD_RATE = 48000
const HEADER = 44

function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(dataBytes === 0 ? 0 : dataBytes + HEADER - 8, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // tamanho do bloco fmt
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RECORD_RATE, 24)
  header.writeUInt32LE(RECORD_RATE * 2, 28) // bytes por segundo
  header.writeUInt16LE(2, 32) // bytes por amostra
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * WAV gravado aos poucos (uma faixa do ao vivo). Enquanto aberto, o cabeçalho diz "tamanho 0":
 * se o app cair, o worker refaz os tamanhos a partir do arquivo (fix_wav_header).
 */
export class WavWriter {
  private queue: Promise<unknown> = Promise.resolve()
  samples = 0

  private constructor(private readonly file: FileHandle) {}

  static async open(
    path: string,
    openFile: (path: string, flags: string) => Promise<FileHandle> = open
  ): Promise<WavWriter> {
    const file = await openFile(path, 'w')
    await file.write(wavHeader(0), 0, HEADER, 0)
    return new WavWriter(file)
  }

  /** Escritas em fila: a ordem dos blocos é a ordem das chamadas, mesmo sem esperar cada uma. */
  append(pcm: Int16Array): Promise<void> {
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const position = HEADER + this.samples * 2
    this.samples += pcm.length
    const write = this.queue.then(() => this.file.write(bytes, 0, bytes.length, position))
    // Uma escrita que falhou (disco cheio) não trava as seguintes: quem chamou recebe o erro.
    this.queue = write.catch(() => undefined)
    return write.then(() => undefined)
  }

  /** Sempre fecha o arquivo (senão ele fica preso, e no Windows não dá para excluir). */
  async close(): Promise<void> {
    await this.queue
    try {
      await this.file.write(wavHeader(this.samples * 2), 0, HEADER, 0)
    } finally {
      await this.file.close()
    }
  }
}
