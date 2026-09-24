import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WavWriter } from '../../../src/main/live/wav'
import { makeTempDir } from '../../helpers/tmp'

function header(buffer: Buffer) {
  return {
    riff: buffer.toString('ascii', 0, 4),
    riffSize: buffer.readUInt32LE(4),
    rate: buffer.readUInt32LE(24),
    bits: buffer.readUInt16LE(34),
    channels: buffer.readUInt16LE(22),
    dataId: buffer.toString('ascii', 36, 40),
    dataSize: buffer.readUInt32LE(40)
  }
}

describe('WavWriter', () => {
  it('grava PCM16 mono 48 kHz com os tamanhos certos ao fechar', async () => {
    const path = join(await makeTempDir(), 'live-voce.wav')
    const wav = await WavWriter.open(path)
    await wav.append(new Int16Array([1, -1, 300]))
    await wav.append(new Int16Array(4800))
    await wav.close()
    const data = await readFile(path)
    expect(header(data)).toEqual({
      riff: 'RIFF',
      riffSize: data.length - 8,
      rate: 48000,
      bits: 16,
      channels: 1,
      dataId: 'data',
      dataSize: (3 + 4800) * 2
    })
    expect(data.readInt16LE(44)).toBe(1)
    expect(data.readInt16LE(46)).toBe(-1)
  })

  it('blocos em sequência mesmo sem esperar cada escrita (ordem preservada)', async () => {
    const path = join(await makeTempDir(), 'a.wav')
    const wav = await WavWriter.open(path)
    void wav.append(new Int16Array([10]))
    void wav.append(new Int16Array([20]))
    await wav.close()
    const data = await readFile(path)
    expect([data.readInt16LE(44), data.readInt16LE(46)]).toEqual([10, 20])
    expect(wav.samples).toBe(2)
  })

  it('arquivo aberto e não fechado (queda) tem cabeçalho com tamanho zero', async () => {
    const path = join(await makeTempDir(), 'b.wav')
    const wav = await WavWriter.open(path)
    await wav.append(new Int16Array([5, 6]))
    const data = await readFile(path)
    expect(header(data).dataSize).toBe(0) // o worker corrige (fix_wav_header) na recuperação
    await wav.close()
  })
})

describe('WavWriter com falhas de escrita', () => {
  it('uma escrita que falha não trava as seguintes, e o close sempre fecha o arquivo', async () => {
    const writes: number[] = []
    let failNext = true
    const file = {
      write: (_buffer: Buffer, _offset: number, length: number, position: number) => {
        if (position > 0 && length > 0 && failNext) {
          failNext = false
          return Promise.reject(Object.assign(new Error('cheio'), { code: 'ENOSPC' }))
        }
        writes.push(position)
        return Promise.resolve({ bytesWritten: length, buffer: _buffer })
      },
      close: vi.fn(() => Promise.resolve())
    }
    const wav = await WavWriter.open('/x.wav', () => Promise.resolve(file as never))
    await expect(wav.append(new Int16Array(10))).rejects.toMatchObject({ code: 'ENOSPC' })
    await wav.append(new Int16Array(10)) // espaço liberado: a próxima grava
    await wav.close()
    expect(writes).toEqual([0, 64, 0]) // cabeçalho, 2º bloco (44 + 20 bytes), cabeçalho final
    expect(file.close).toHaveBeenCalled()
  })

  it('cabeçalho final que falha ainda fecha o arquivo e repassa o erro', async () => {
    const file = {
      write: vi
        .fn()
        .mockResolvedValueOnce({ bytesWritten: 44 })
        .mockRejectedValueOnce(new Error('cheio')),
      close: vi.fn(() => Promise.resolve())
    }
    const wav = await WavWriter.open('/x.wav', () => Promise.resolve(file as never))
    await expect(wav.close()).rejects.toThrow('cheio')
    expect(file.close).toHaveBeenCalled()
  })
})
