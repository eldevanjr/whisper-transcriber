import { describe, expect, it } from 'vitest'
import {
  errorFromEvent,
  LineSplitter,
  parseWorkerEvent,
  PROTOCOL_VERSION,
  serializeCommand
} from '../../../src/main/worker/protocol'

describe('parseWorkerEvent', () => {
  it.each([
    [{ type: 'ready', protocol: 1, version: '0.1.0' }],
    [{ type: 'heartbeat' }],
    [{ type: 'result', id: '1', data: { ok: true } }],
    [{ type: 'error', code: 'NO_AUDIO', message: 'x', id: '1', job_id: 'j', detail: 'd' }],
    [{ type: 'phase', phase: 'loading_model', job_id: null }],
    [{ type: 'progress', job_id: 'j', pct: 50, processed_s: 1, total_s: 2, speed: 1.5 }],
    [{ type: 'segment', job_id: 'j', index: 0, start: 0, end: 1, text: 'olá' }],
    [{ type: 'done', job_id: 'j', duration: 2, language_detected: null }]
  ])('aceita %j', (event) => {
    expect(parseWorkerEvent(JSON.stringify(event))).toEqual(event)
  })

  it.each(['não é json', '{"type":"desconhecido"}', '{"type":"segment","job_id":"j"}', '[]'])(
    'rejeita %s',
    (line) => {
      expect(parseWorkerEvent(line)).toBeNull()
    }
  )
})

describe('serializeCommand', () => {
  it('gera uma linha JSON com id e parâmetros, preservando acentos', () => {
    const line = serializeCommand('7', {
      cmd: 'transcribe',
      params: {
        job_id: 'j',
        input_path: 'C:\\Usuários\\vídeo.mp4',
        language: null,
        audio_out_path: '/h/a.m4a'
      }
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({
      id: '7',
      cmd: 'transcribe',
      params: {
        job_id: 'j',
        input_path: 'C:\\Usuários\\vídeo.mp4',
        language: null,
        audio_out_path: '/h/a.m4a'
      }
    })
  })

  it('comandos sem parâmetros', () => {
    expect(serializeCommand('1', { cmd: 'shutdown' })).toBe('{"id":"1","cmd":"shutdown"}\n')
  })
})

describe('errorFromEvent', () => {
  it('mapeia código conhecido e preserva detalhe', () => {
    const error = errorFromEvent({ type: 'error', code: 'CUDA_FAILED', message: 'm', detail: 'd' })
    expect(error.toInfo()).toEqual({ code: 'CUDA_FAILED', message: 'm', detail: 'd' })
  })

  it('código desconhecido vira INTERNAL', () => {
    expect(errorFromEvent({ type: 'error', code: 'NOVO', message: 'm' }).code).toBe('INTERNAL')
  })
})

describe('LineSplitter', () => {
  it('junta pedaços, separa linhas e guarda o resto', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"a":')).toEqual([])
    expect(splitter.push('1}\n{"b":2}\r\n\n  \n{"c"')).toEqual(['{"a":1}', '{"b":2}'])
    expect(splitter.push(':3}\n')).toEqual(['{"c":3}'])
  })
})

it('versão do protocolo é 4 (IA em processo próprio)', () => {
  expect(PROTOCOL_VERSION).toBe(4)
})

it('eventos do ao vivo (protocolo v3)', () => {
  expect(
    parseWorkerEvent(
      '{"type":"live_segment","session_id":"s","track":"voce","start":1,"end":2,"text":"oi"}'
    )
  ).toEqual({ type: 'live_segment', session_id: 's', track: 'voce', start: 1, end: 2, text: 'oi' })
  expect(
    parseWorkerEvent('{"type":"live_listening","session_id":"s","track":"outros","active":true}')
  ).toMatchObject({ active: true })
  expect(parseWorkerEvent('{"type":"live_lag","session_id":"s","seconds":4.5}')).toMatchObject({
    seconds: 4.5
  })
  expect(
    parseWorkerEvent('{"type":"live_error","session_id":"s","code":"GPU_FAILED"}')
  ).toMatchObject({ code: 'GPU_FAILED' })
  expect(
    parseWorkerEvent(
      '{"type":"live_segment","session_id":"s","track":"alguem","start":1,"end":2,"text":"x"}'
    )
  ).toBeNull()
})

describe('eventos de IA', () => {
  it('ai_analysis diz se o resultado é final (worker antigo: parcial)', () => {
    const final = parseWorkerEvent(
      JSON.stringify({ type: 'ai_analysis', transcription_id: 't', result: {}, final: true })
    )
    expect(final).toEqual({ type: 'ai_analysis', transcription_id: 't', result: {}, final: true })
    const legacy = parseWorkerEvent(
      JSON.stringify({ type: 'ai_analysis', transcription_id: 't', result: {} })
    )
    expect(legacy).toMatchObject({ final: false })
  })

  it('serializa os comandos novos da IA', () => {
    const line = serializeCommand('1', {
      cmd: 'analysis_append',
      params: { transcription_id: 't', workspace_id: 'ws', title: 'R', segments: [] }
    })
    expect(JSON.parse(line)).toMatchObject({ cmd: 'analysis_append' })
    expect(
      JSON.parse(serializeCommand('2', { cmd: 'ai_status', params: { workspace_id: 'ws' } }))
    ).toMatchObject({ params: { workspace_id: 'ws' } })
  })
})
