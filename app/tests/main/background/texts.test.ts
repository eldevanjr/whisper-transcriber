import { describe, expect, it } from 'vitest'
import { createTranslate } from '../../../src/main/background/texts'

describe('createTranslate', () => {
  it('usa os mesmos textos da interface, com variáveis', () => {
    const t = createTranslate('pt-BR')
    expect(t('background.quit')).toBe('Sair')
    expect(t('background.tooltipRecording', { time: '01:02' })).toBe('Gravando — 01:02')
    expect(createTranslate('en')('background.quit')).toBe('Quit')
    expect(createTranslate('es')('errors.QUEUE_BUSY')).toContain('cola')
  })

  it('cai para o inglês, depois para a própria chave; variável ausente fica como está', () => {
    const resources = { 'pt-BR': { a: { b: 'só pt {{x}}' } }, en: { c: 'en' }, es: {} }
    const t = createTranslate('pt-BR', resources)
    expect(t('a.b')).toBe('só pt {{x}}')
    expect(t('c')).toBe('en')
    expect(t('a')).toBe('a') // nó que não é texto
    expect(t('a.b.c')).toBe('a.b.c') // caminho que passa de um texto
    expect(t('nada')).toBe('nada')
  })
})
