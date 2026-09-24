import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  formatTime,
  paragraphsToText,
  segmentsToEntries,
  toJson,
  toParagraphs,
  toTimestamped
} from '../../src/shared/format'
import type { TranscriptEntry } from '../../src/shared/history'

const e = (inicio: number, fim: number, texto: string): TranscriptEntry => ({ inicio, fim, texto })

describe('formatTime', () => {
  it('mm:ss abaixo de 1 h e hh:mm:ss a partir dela, truncando', () => {
    expect(formatTime(0)).toBe('00:00')
    expect(formatTime(59.99)).toBe('00:59')
    expect(formatTime(61)).toBe('01:01')
    expect(formatTime(3599.9)).toBe('59:59')
    expect(formatTime(3600)).toBe('01:00:00')
    expect(formatTime(36_000 + 62)).toBe('10:01:02')
  })

  it('negativos e não finitos viram 00:00', () => {
    expect(formatTime(-3)).toBe('00:00')
    expect(formatTime(Number.NaN)).toBe('00:00')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('00:00')
  })

  it('ida e volta: ler o texto de volta dá os segundos inteiros', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 400_000, noNaN: true }), (seconds) => {
        const parts = formatTime(seconds).split(':').map(Number)
        const back = parts.reduce((total, part) => total * 60 + part, 0)
        return back === Math.floor(seconds)
      })
    )
  })
})

describe('toTimestamped', () => {
  it('uma linha por trecho, igual ao .txt do CLI', () => {
    expect(toTimestamped([e(0, 1.5, 'Olá.'), e(3599, 3601, 'virou a hora')])).toBe(
      '[00:00 - 00:01] Olá.\n[59:59 - 01:00:01] virou a hora\n'
    )
    expect(toTimestamped([])).toBe('')
  })
})

describe('toJson', () => {
  it('igual ao .json do CLI: indentação 4, floats do Python e acentos sem escape', () => {
    expect(toJson([])).toBe('[]')
    expect(toJson([e(0, 1.5, 'ação')])).toBe(
      '[\n    {\n        "inicio": 0.0,\n        "fim": 1.5,\n        "texto": "ação"\n    }\n]'
    )
  })
})

describe('segmentsToEntries', () => {
  it('arredonda para 3 casas no formato do histórico', () => {
    expect(segmentsToEntries([{ start: 0.12345, end: 2, text: 'a' }])).toEqual([
      { inicio: 0.123, fim: 2, texto: 'a' }
    ])
  })
})

describe('toParagraphs', () => {
  it('quebra em pausa de 1,5 s ou mais', () => {
    const paragraphs = toParagraphs([e(0, 1, 'Um.'), e(1.2, 2, 'Dois.'), e(3.5, 4, 'Três.')])
    expect(paragraphs).toEqual([
      { start: 0, end: 2, text: 'Um. Dois.' },
      { start: 3.5, end: 4, text: 'Três.' }
    ])
    expect(paragraphsToText(paragraphs)).toBe('Um. Dois.\n\nTrês.')
  })

  it('passa de 600 caracteres: quebra só no fim de uma frase', () => {
    const long = 'palavra '.repeat(80).trim() // 639 caracteres, sem ponto
    const paragraphs = toParagraphs([
      e(0, 1, long),
      e(1, 2, 'continua'),
      e(2, 3, 'fim.'),
      e(3, 4, 'Novo.')
    ])
    expect(paragraphs.map((p) => p.text)).toEqual([`${long} continua fim.`, 'Novo.'])
  })

  it.each(['!', '?', '…'])('termina frase com %s', (mark) => {
    const long = `${'x'.repeat(601)}${mark}`
    expect(toParagraphs([e(0, 1, long), e(1, 2, 'b')])).toHaveLength(2)
  })

  it('apara espaços e ignora trechos vazios', () => {
    expect(toParagraphs([e(0, 1, ' Oi '), e(1, 2, '   '), e(2, 3, ' tudo bem? ')])).toEqual([
      { start: 0, end: 3, text: 'Oi tudo bem?' }
    ])
    expect(toParagraphs([])).toEqual([])
  })

  it('preserva todas as palavras, na ordem', () => {
    const entry = fc.tuple(
      fc.float({ min: 0, max: 3, noNaN: true }),
      fc.stringMatching(/^[a-z]{1,8}[.!?]?$/)
    )
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 60 }), (items) => {
        let t = 0
        const entries = items.map(([gap, text]) => {
          const start = t + gap
          t = start + 1
          return e(start, t, text)
        })
        const words = paragraphsToText(toParagraphs(entries)).split(/\s+/).filter(Boolean)
        return words.join(' ') === entries.map((x) => x.texto).join(' ')
      })
    )
  })
})

describe('formatos com falante (ao vivo)', () => {
  const labels = { voce: 'Você', outros: 'Outros' }
  const conversa: TranscriptEntry[] = [
    { inicio: 0, fim: 2, texto: 'Bom dia.', falante: 'outros' },
    { inicio: 2.2, fim: 4, texto: 'Vamos começar?', falante: 'outros' },
    { inicio: 4.3, fim: 6, texto: 'Pode ser.', falante: 'voce' }
  ]

  it('com tempos: rótulo do falante em cada linha', () => {
    expect(toTimestamped(conversa, labels)).toBe(
      '[00:00 - 00:02] Outros: Bom dia.\n[00:02 - 00:04] Outros: Vamos começar?\n[00:04 - 00:06] Você: Pode ser.\n'
    )
  })

  it('parágrafos quebram na troca de falante e o texto leva o rótulo', () => {
    const paragraphs = toParagraphs(conversa)
    expect(paragraphs.map((p) => [p.falante, p.text])).toEqual([
      ['outros', 'Bom dia. Vamos começar?'],
      ['voce', 'Pode ser.']
    ])
    expect(paragraphsToText(paragraphs, labels)).toBe(
      'Outros: Bom dia. Vamos começar?\n\nVocê: Pode ser.'
    )
  })

  it('JSON inclui o falante', () => {
    expect(toJson([conversa[2]!])).toBe(
      '[\n    {\n        "inicio": 4.3,\n        "fim": 6.0,\n        "texto": "Pode ser.",\n        "falante": "voce"\n    }\n]'
    )
  })

  it('sem falante (arquivos) nada muda, mesmo passando os rótulos', () => {
    const entries = [{ inicio: 0, fim: 1, texto: 'Oi.' }]
    expect(toTimestamped(entries, labels)).toBe('[00:00 - 00:01] Oi.\n')
    expect(paragraphsToText(toParagraphs(entries), labels)).toBe('Oi.')
  })
})
