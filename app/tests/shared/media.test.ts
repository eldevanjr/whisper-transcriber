import { describe, expect, it } from 'vitest'
import { fileNameOf, mediaKindOf } from '../../src/shared/media'

describe('media', () => {
  it.each([
    ['/v/aula.MP4', 'video'],
    ['C:\\Vídeos\\reunião.mkv', 'video'],
    ['audio.m4a', 'audio'],
    ['voz.OPUS', 'audio'],
    ['doc.pdf', null],
    ['sem-extensao', null],
    ['pasta.mp4/arquivo', null]
  ])('mediaKindOf(%s) = %s', (path, kind) => {
    expect(mediaKindOf(path)).toBe(kind)
  })

  it('fileNameOf aceita / e \\', () => {
    expect(fileNameOf('/a/b/aula 03.mp4')).toBe('aula 03.mp4')
    expect(fileNameOf('C:\\Users\\João\\vídeo.mp4')).toBe('vídeo.mp4')
    expect(fileNameOf('solto.wav')).toBe('solto.wav')
  })
})
