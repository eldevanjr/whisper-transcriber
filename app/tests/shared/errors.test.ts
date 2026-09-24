import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError, isErrorCode, toAppError, WORKER_ERROR_CODES } from '../../src/shared/errors'

describe('errors', () => {
  it('mantém os códigos do worker idênticos aos do Python (contrato)', () => {
    const python = readFileSync(
      join(__dirname, '../../../worker/transcriber_worker/errors.py'),
      'utf8'
    )
    const codes = [...python.matchAll(/^\s+([A-Z_]+) = "\1"$/gm)].map((m) => m[1])
    expect(codes).toEqual([...WORKER_ERROR_CODES])
  })

  it('AppError guarda código, mensagem e detalhe', () => {
    const error = new AppError('NO_AUDIO', 'sem áudio', 'det')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppError')
    expect(error.toInfo()).toEqual({ code: 'NO_AUDIO', message: 'sem áudio', detail: 'det' })
  })

  it('toInfo omite detalhe ausente', () => {
    expect(new AppError('INTERNAL', 'x').toInfo()).toEqual({ code: 'INTERNAL', message: 'x' })
  })

  it('isErrorCode reconhece só códigos conhecidos', () => {
    expect(isErrorCode('CUDA_FAILED')).toBe(true)
    expect(isErrorCode('WORKER_CRASHED')).toBe(true)
    expect(isErrorCode('NOPE')).toBe(false)
    expect(isErrorCode(42)).toBe(false)
  })

  it('toAppError preserva AppError e embrulha o resto como INTERNAL', () => {
    const original = new AppError('CANCELED', 'x')
    expect(toAppError(original)).toBe(original)
    expect(toAppError(new Error('boom')).toInfo()).toEqual({ code: 'INTERNAL', message: 'boom' })
    expect(toAppError('texto').message).toBe('texto')
  })
})
