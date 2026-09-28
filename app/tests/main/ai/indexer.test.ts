import { describe, expect, it, vi } from 'vitest'
import { APPEND_SPAN_SECONDS, TranscriptionIndexer } from '../../../src/main/ai/indexer'
import type { LiveEvent, QueueEvent } from '../../../src/shared/events'
import type { HistoryMeta } from '../../../src/shared/history'

const ID = '11111111-1111-4111-8111-111111111111'
const LIVE = '22222222-2222-4222-8222-222222222222'

function meta(status: HistoryMeta['status'], fileName = 'a.mp4'): HistoryMeta {
  return {
    id: ID,
    fileName,
    sourcePath: '/a.mp4',
    mediaKind: 'audio',
    createdAt: '2026-09-26T00:00:00.000Z',
    status,
    model: 'small',
    language: null,
    languageDetected: 'pt',
    duration: 10,
    error: null,
    kind: 'file'
  }
}

function segment(start: number, text: string): QueueEvent {
  return { type: 'segment', jobId: ID, segment: { start, end: start + 1, text } }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

interface Sent {
  transcriptionId: string
  title: string
  segments: { index: number; start: number; end: number; text: string }[]
}

function setup(overrides: { submit?: () => Promise<void>; titleOf?: () => Promise<string> } = {}) {
  const submit = vi.fn<(input: Sent) => Promise<void>>(overrides.submit ?? (async () => undefined))
  const append = vi.fn<(input: Sent) => Promise<void>>(async () => undefined)
  const forget = vi.fn(async () => undefined)
  const logger = { warn: vi.fn() }
  const indexer = new TranscriptionIndexer({
    session: { submit, append, forget },
    logger,
    titleOf: overrides.titleOf ?? (async () => 'Reunião ao vivo')
  })
  return { indexer, submit, append, forget, logger }
}

describe('TranscriptionIndexer — arquivos', () => {
  it('acumula segmentos e envia tudo no done', async () => {
    const { indexer, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'a'))
    indexer.onEvent(segment(1, 'b'))
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    expect(submit).toHaveBeenCalledWith({
      transcriptionId: ID,
      title: 'a.mp4',
      segments: [
        { index: 0, start: 0, end: 1, text: 'a' },
        { index: 1, start: 1, end: 2, text: 'b' }
      ]
    })
  })

  it('manda lotes para a análise enquanto a transcrição anda', async () => {
    const { indexer, append, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'a'))
    indexer.onEvent(segment(10, 'b'))
    expect(append).not.toHaveBeenCalled()
    indexer.onEvent(segment(APPEND_SPAN_SECONDS, 'c'))
    await flush()
    expect(append).toHaveBeenCalledWith({
      transcriptionId: ID,
      title: 'a.mp4',
      segments: [
        { index: 0, start: 0, end: 1, text: 'a' },
        { index: 1, start: 10, end: 11, text: 'b' },
        { index: 2, start: APPEND_SPAN_SECONDS, end: APPEND_SPAN_SECONDS + 1, text: 'c' }
      ]
    })
    indexer.onEvent(segment(APPEND_SPAN_SECONDS + 5, 'd'))
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    expect(submit.mock.calls[0]?.[0].segments).toHaveLength(4)
  })

  it('outros estados do job não mexem no acumulado', async () => {
    const { indexer, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'a'))
    indexer.onEvent({ type: 'job', meta: meta('queued') })
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    expect(submit.mock.calls[0]?.[0].segments).toHaveLength(1)
  })

  it('done de item não acompanhado (ex.: trocar versão) não envia nada', async () => {
    const { indexer, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    expect(submit).not.toHaveBeenCalled()
  })

  it('refazer recomeça o acumulado', async () => {
    const { indexer, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'antigo'))
    indexer.onEvent({ type: 'job', meta: meta('failed') })
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'novo'))
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    expect(submit.mock.calls[0]?.[0].segments).toEqual([
      { index: 0, start: 0, end: 1, text: 'novo' }
    ])
  })

  it('excluir do histórico apaga o conhecimento derivado', async () => {
    const { indexer, forget, submit } = setup()
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'a'))
    indexer.onEvent({ type: 'removed', jobId: ID })
    await flush()
    expect(forget).toHaveBeenCalledWith(ID)
    expect(submit).not.toHaveBeenCalled()
  })

  it('ignora eventos que não interessam e segmentos de job desconhecido', async () => {
    const { indexer, submit, append } = setup()
    indexer.onEvent({ type: 'phase', jobId: ID, phase: 'transcribing' })
    indexer.onEvent(segment(0, 'solto'))
    await flush()
    expect(submit).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('falha ao enviar é registrada e não propaga', async () => {
    const { indexer, logger } = setup({
      submit: async () => {
        throw new Error('ollama offline')
      }
    })
    indexer.onEvent({ type: 'job', meta: meta('processing') })
    indexer.onEvent(segment(0, 'a'))
    indexer.onEvent({ type: 'job', meta: meta('done') })
    await flush()
    await flush()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ollama offline'))
  })
})

describe('TranscriptionIndexer — ao vivo', () => {
  const state = (s: LiveEvent & { type: 'state' }): LiveEvent => s
  const liveSegment = (start: number, text: string): LiveEvent => ({
    type: 'segment',
    track: 'voce',
    start,
    end: start + 1,
    text
  })

  it('analisa a gravação ao vivo e envia tudo ao encerrar', async () => {
    const { indexer, submit, append } = setup()
    indexer.onLiveEvent(state({ type: 'state', state: 'recording', test: false, itemId: LIVE }))
    indexer.onLiveEvent(liveSegment(0, 'oi'))
    indexer.onLiveEvent(liveSegment(APPEND_SPAN_SECONDS, 'tudo bem'))
    indexer.onLiveEvent(state({ type: 'state', state: 'paused', test: false, itemId: LIVE }))
    indexer.onLiveEvent(state({ type: 'state', state: 'stopping', test: false, itemId: LIVE }))
    indexer.onLiveEvent(state({ type: 'state', state: 'idle', test: false, itemId: null }))
    await flush()
    await flush()
    expect(append).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptionId: LIVE, title: 'Reunião ao vivo' })
    )
  })

  it('teste de microfone e trechos sem sessão não são analisados', async () => {
    const { indexer, submit, append } = setup()
    indexer.onLiveEvent(liveSegment(0, 'solto'))
    indexer.onLiveEvent(state({ type: 'state', state: 'recording', test: true, itemId: null }))
    indexer.onLiveEvent(liveSegment(0, 'teste'))
    indexer.onLiveEvent(state({ type: 'state', state: 'idle', test: true, itemId: null }))
    indexer.onLiveEvent({ type: 'lag', seconds: 1 })
    await flush()
    expect(submit).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
  })

  it('sem título no histórico, usa um genérico', async () => {
    const { indexer, submit } = setup({
      titleOf: async () => {
        throw new Error('sumiu')
      }
    })
    indexer.onLiveEvent(state({ type: 'state', state: 'recording', test: false, itemId: LIVE }))
    indexer.onLiveEvent(liveSegment(0, 'oi'))
    indexer.onLiveEvent(state({ type: 'state', state: 'idle', test: false, itemId: null }))
    await flush()
    await flush()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ao vivo' }))
  })
})
