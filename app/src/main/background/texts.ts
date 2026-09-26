import en from '../../renderer/src/i18n/en.json'
import es from '../../renderer/src/i18n/es.json'
import ptBR from '../../renderer/src/i18n/pt-BR.json'
import type { UiLanguage } from '../../shared/language'

export type Translate = (key: string, vars?: Record<string, string | number>) => string

const RESOURCES: Record<UiLanguage, unknown> = { 'pt-BR': ptBR, en, es }

function lookup(resource: unknown, key: string): string | null {
  let node = resource
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return null
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : null
}

/** Tradução no main (bandeja e notificações) com os mesmos arquivos da interface. */
export function createTranslate(
  language: UiLanguage,
  resources: Record<UiLanguage, unknown> = RESOURCES
): Translate {
  return (key, vars = {}) => {
    const text = lookup(resources[language], key) ?? lookup(resources.en, key) ?? key
    return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      name in vars ? String(vars[name]) : match
    )
  }
}
