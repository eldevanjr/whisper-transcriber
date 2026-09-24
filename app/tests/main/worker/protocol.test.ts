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

it('versão do protocolo é 3 (transcrição ao vivo)', () => {
  expect(PROTOCOL_VERSION).toBe(3)
})
