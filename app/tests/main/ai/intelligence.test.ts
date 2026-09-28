import { describe, expect, it } from 'vitest'
import {
  normalizeAnalysis,
  normalizeAnswer,
  normalizeDiagnostics,
  normalizeStatus,
  withWhisperCheck
} from '../../../src/main/ai/intelligence'

describe('normalizeAnalysis', () => {
  it('achata todas as entidades com texto, detalhe, confiança e tempo', () => {
    const result = normalizeAnalysis({
      summary: 'Reunião sobre sincronização',
      model: 'qwen',
      topics: [
        {
          id: 't1',
          name: 'Sincronização',
          description: 'como sincronizar',
          confidence: 0.9,
          source_segments: [{ start: 12.5, end: 20 }]
        }
      ],
      tasks: [{ id: 'k1', description: 'Corrigir', assignee: 'Ana', deadline: 'sexta' }],
      decisions: [{ description: 'Usar SQLite' }],
      problems: [{ description: 'Lentidão', severity: 'alta' }],
      questions: [{ question: 'Quando?', confidence: 0.5 }],
      people: [{ id: 'p1', name: 'Ana', role: 'QA' }]
    })
    expect(result.model).toBe('qwen')
    expect(result.summary).toBe('Reunião sobre sincronização')
    expect(result.items.map((item) => item.kind)).toEqual([
      'topic',
      'task',
      'decision',
      'problem',
      'question',
      'person'
    ])
    const [topic] = result.items
    expect(topic).toMatchObject({
      id: 't1',
      kind: 'topic',
      text: 'Sincronização',
      detail: 'como sincronizar',
      confidence: 0.9,
      state: null,
      start: 12.5,
      end: 20
    })
    expect(result.items.find((item) => item.kind === 'task')?.detail).toBe('Ana · sexta')
    expect(result.items.find((item) => item.kind === 'problem')?.detail).toBe('alta')
    expect(result.items.find((item) => item.kind === 'person')?.detail).toBe('QA')
  })

  it('sem id usa kind:texto; confiança inválida vira 0; sem tempo fica null', () => {
    const result = normalizeAnalysis({
      topics: [{ name: 'Sem id' }],
      questions: [{ question: 'Q?', confidence: 'alta' }]
    })
    expect(result.items[0]).toMatchObject({
      id: 'topic:Sem id',
      confidence: 0,
      start: null,
      end: null
    })
    expect(result.items[1]).toMatchObject({ kind: 'question', text: 'Q?', confidence: 0 })
  })

  it('ignora entradas sem texto ou de tipo errado', () => {
    const result = normalizeAnalysis({
      topics: [null, { description: 'sem nome' }],
      tasks: 'não é lista',
      people: [{ name: 'Ok' }]
    })
    expect(result.items.map((item) => item.text)).toEqual(['Ok'])
    expect(result.model).toBeNull()
  })

  it('sem start no source_segments não quebra', () => {
    const result = normalizeAnalysis({
      topics: [
        { name: 'X', source_segments: [{ end: 5 }, 'nada'] },
        { name: 'Y', source_segments: [{ start: 2 }] }
      ]
    })
    expect(result.items[0]).toMatchObject({ start: null, end: null })
    expect(result.items[1]).toMatchObject({ start: 2, end: null })
  })

  it('entrada que não é objeto devolve vazio', () => {
    expect(normalizeAnalysis(null)).toEqual({ summary: null, items: [], model: null })
    expect(normalizeAnalysis('texto')).toEqual({ summary: null, items: [], model: null })
  })

  it('summary ausente ou vazio vira null', () => {
    expect(normalizeAnalysis({ topics: [{ name: 'X' }] }).summary).toBeNull()
    expect(normalizeAnalysis({ summary: '' }).summary).toBeNull()
  })
})

describe('normalizeStatus', () => {
  it('conta pendências de análise e o progresso da indexação', () => {
    const status = normalizeStatus({
      configured: true,
      enabled: true,
      analysis: { PENDING: 2, PROCESSING: 1, COMPLETED: 5, RUIM: 'x' },
      index: { PENDING: 1, PROCESSING: 1, COMPLETED: 6, FAILED: 2 },
      storage: { kind: 'postgres', fallback: false, reason: null }
    })
    expect(status).toEqual({
      configured: true,
      enabled: true,
      pendingAnalysis: 3,
      failedAnalysis: 0,
      index: { total: 10, completed: 6, pending: 2, failed: 2 },
      storage: { kind: 'postgres', fallback: false, reason: null },
      blocked: null,
      reindexRequired: false
    })
  })

  it('sem dados fica desligado, sem análise e sem storage', () => {
    expect(normalizeStatus({})).toEqual({
      configured: false,
      enabled: false,
      pendingAnalysis: 0,
      failedAnalysis: 0,
      index: { total: 0, completed: 0, pending: 0, failed: 0 },
      storage: null,
      blocked: null,
      reindexRequired: false
    })
  })

  it('registra o fallback para SQLite', () => {
    const status = normalizeStatus({
      configured: true,
      enabled: true,
      storage: { kind: 'sqlite', fallback: true, reason: 'sem docker' }
    })
    expect(status.storage).toEqual({ kind: 'sqlite', fallback: true, reason: 'sem docker' })
  })

  it('campos malformados não viram status válido', () => {
    const status = normalizeStatus({ analysis: 5, index: 'x', storage: 'nope' })
    expect(status.pendingAnalysis).toBe(0)
    expect(status.index.total).toBe(0)
    expect(status.storage).toBeNull()
  })

  it('storage sem campos usa os padrões', () => {
    const status = normalizeStatus({ configured: true, enabled: true, storage: {} })
    expect(status.storage).toEqual({ kind: 'sqlite', fallback: false, reason: null })
  })
})

describe('normalizeDiagnostics', () => {
  it('mapeia nome, ok e detalhe', () => {
    expect(
      normalizeDiagnostics({
        checks: [
          { name: 'ollama', ok: true, detail: 'ok' },
          { name: 'postgres', ok: false, detail: null }
        ]
      })
    ).toEqual([
      { name: 'ollama', ok: true, detail: 'ok' },
      { name: 'postgres', ok: false, detail: null }
    ])
  })

  it('ignora entradas inválidas e campos malformados', () => {
    expect(
      normalizeDiagnostics({
        checks: [null, { ok: true }, { name: 'llm', ok: 'sim', detail: 5 }]
      })
    ).toEqual([{ name: 'llm', ok: false, detail: null }])
  })

  it('sem lista devolve vazio', () => {
    expect(normalizeDiagnostics({ checks: 'x' })).toEqual([])
    expect(normalizeDiagnostics({})).toEqual([])
  })
})

describe('campos novos da IA', () => {
  it('estado da entidade (DETECTED/UPDATED/CONFIRMED/CANCELLED)', () => {
    const result = normalizeAnalysis({ tasks: [{ description: 'Deploy', state: 'UPDATED' }] })
    expect(result.items[0]?.state).toBe('UPDATED')
  })

  it('status traz bloqueio, falhas e reindexação necessária', () => {
    const status = normalizeStatus({
      configured: true,
      enabled: true,
      blocked: 'Ollama remoto',
      analysis: { FAILED: 2 },
      reindex_required: true
    })
    expect(status).toMatchObject({
      blocked: 'Ollama remoto',
      failedAnalysis: 2,
      reindexRequired: true
    })
  })

  it('resposta do RAG com fontes, tempo e título', () => {
    const answer = normalizeAnswer({
      answer: 'João faz o deploy [30.0s-35.0s]',
      model: 'qwen',
      sources: [
        {
          chunk: {
            content: 'João fará o deploy',
            metadata: { transcription_id: 't1', start_time: 30, end_time: 35 }
          },
          source: { title: 'Reunião 26/09' }
        },
        { chunk: { content: 'sem metadados' } },
        { chunk: {} },
        'lixo'
      ]
    })
    expect(answer).toEqual({
      answer: 'João faz o deploy [30.0s-35.0s]',
      model: 'qwen',
      sources: [
        {
          transcriptionId: 't1',
          title: 'Reunião 26/09',
          text: 'João fará o deploy',
          start: 30,
          end: 35
        },
        { transcriptionId: null, title: null, text: 'sem metadados', start: null, end: null },
        { transcriptionId: null, title: null, text: '', start: null, end: null }
      ]
    })
    expect(normalizeAnswer({})).toEqual({ answer: '', model: null, sources: [] })
  })

  it('o diagnóstico do Whisper vem do app (o processo da IA não carrega modelo)', () => {
    const checks = [
      { name: 'whisper', ok: false, detail: 'não verificado' },
      { name: 'ollama', ok: true, detail: null }
    ]
    expect(withWhisperCheck(checks, 'small')[0]).toEqual({
      name: 'whisper',
      ok: true,
      detail: 'small'
    })
    expect(withWhisperCheck(checks, null)[0]).toMatchObject({ name: 'whisper', ok: false })
    expect(withWhisperCheck([], 'small')).toEqual([{ name: 'whisper', ok: true, detail: 'small' }])
  })
})
