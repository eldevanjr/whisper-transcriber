import { describe, expect, it } from 'vitest'
import {
  HistoryMetaSchema,
  isJobId,
  toTranscriptEntry,
  TranscriptEntrySchema
} from '../../src/shared/history'

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
    expect(HistoryMetaSchema.parse(meta)).toEqual({ ...meta, kind: 'file' })
    expect(HistoryMetaSchema.safeParse({ ...meta, status: 'x' }).success).toBe(false)
  })
})

describe('histórico do ao vivo', () => {
  const base = {
    id: '0b6d7e1c-2f0a-4c8e-9d1b-3a5f6c7d8e9f',
    fileName: 'Reunião',
    sourcePath: '',
    mediaKind: 'audio',
    createdAt: '2026-09-23T10:00:00.000Z',
    status: 'done',
    model: 'medium',
    language: null,
    languageDetected: null,
    duration: 60,
    error: null
  }

  it('item antigo (sem kind) é de arquivo', () => {
    expect(HistoryMetaSchema.parse(base).kind).toBe('file')
  })

  it('item ao vivo guarda as faixas e a versão ativa', () => {
    const meta = HistoryMetaSchema.parse({
      ...base,
      kind: 'live',
      tracks: ['voce', 'outros'],
      activeVersion: 'live'
    })
    expect(meta.tracks).toEqual(['voce', 'outros'])
    expect(meta.activeVersion).toBe('live')
    expect(HistoryMetaSchema.safeParse({ ...base, tracks: ['alguem'] }).success).toBe(false)
  })

  it('trecho pode ter falante', () => {
    expect(
      TranscriptEntrySchema.parse({ inicio: 0, fim: 1, texto: 'oi', falante: 'voce' })
    ).toEqual({
      inicio: 0,
      fim: 1,
      texto: 'oi',
      falante: 'voce'
    })
  })
})
