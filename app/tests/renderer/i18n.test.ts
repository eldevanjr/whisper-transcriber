import { describe, expect, it } from 'vitest'
import { createI18n, resolveLanguage, RESOURCES } from '../../src/renderer/src/i18n'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`)
  )
}

describe('i18n', () => {
  it('pt-BR, en e es têm exatamente as mesmas chaves, sem textos vazios', () => {
    const reference = keys(RESOURCES['pt-BR'].translation).sort()
    for (const language of ['en', 'es'] as const) {
      expect(keys(RESOURCES[language].translation).sort()).toEqual(reference)
    }
    for (const resource of Object.values(RESOURCES)) {
      const flat = JSON.stringify(resource.translation)
      expect(flat).not.toContain('""')
    }
  })

  it('resolveLanguage: configuração vence; sem ela, segue o sistema', () => {
    expect(resolveLanguage('es', 'pt-BR')).toBe('es')
    expect(resolveLanguage(null, 'pt-PT')).toBe('pt-BR')
    expect(resolveLanguage(null, 'es-419')).toBe('es')
    expect(resolveLanguage(null, 'de-DE')).toBe('en')
  })

  it('createI18n traduz no idioma pedido e cai para o inglês', () => {
    const i18n = createI18n('es')
    expect(i18n.t('common.back')).toBe('Volver')
    expect(i18n.t('chave.inexistente')).toBe('chave.inexistente')
  })
})
