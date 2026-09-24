import { describe, expect, it } from 'vitest'
import { HistoryMetaSchema, isJobId, toTranscriptEntry } from '../../src/shared/history'

export const JOB_ID = '3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f'

describe('history', () => {
  it('toTranscriptEntry converte para o formato atual com 3 casas', () => {
    expect(toTranscriptEntry({ start: 1.23456, end: 2, text: 'olá' })).toEqual({
      inicio: 1.235,
      fim: 2,
      texto: 'olá'
    })
  })

  it('isJobId aceita só UUID e barra path traversal', () => {
    expect(isJobId(JOB_ID)).toBe(true)
    expect(isJobId('../../etc/passwd')).toBe(false)
    expect(isJobId('..\\..\\Windows')).toBe(false)
    expect(isJobId(`${JOB_ID}/../x`)).toBe(false)
    expect(isJobId(7)).toBe(false)
  })

  it('HistoryMetaSchema valida um item completo', () => {
    const meta = {
      id: JOB_ID,
      fileName: 'a.mp4',
      sourcePath: '/a.mp4',
      mediaKind: 'video',
      createdAt: '2026-09-23T10:00:00.000Z',
      status: 'failed',
      model: 'medium',
      language: 'pt',
      languageDetected: null,
      duration: null,
      error: { code: 'NO_AUDIO', message: 'sem áudio' }
    }
    expect(HistoryMetaSchema.parse(meta)).toEqual(meta)
    expect(HistoryMetaSchema.safeParse({ ...meta, status: 'x' }).success).toBe(false)
  })
})
