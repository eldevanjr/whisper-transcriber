import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { UI_LANGUAGES } from '../../../shared/settings'
import { speakerLabelsFor } from '../../../shared/speakers'
import en from './en.json'
import es from './es.json'
import ptBR from './pt-BR.json'

export type UiLanguage = (typeof UI_LANGUAGES)[number]

/**
 * Injeta os rótulos dos falantes (fonte única em `shared/speakers.ts`) nas traduções, para
 * `t('live.you')`/`t('live.others')` continuarem funcionando sem duplicar as palavras no JSON.
 */
function withSpeakerLabels<T extends { live: Record<string, unknown> }>(
  resource: T,
  language: UiLanguage
): T & { live: { you: string; others: string } } {
  const labels = speakerLabelsFor(language)
  return { ...resource, live: { ...resource.live, you: labels.voce, others: labels.outros } }
}

export const RESOURCES = {
  'pt-BR': { translation: withSpeakerLabels(ptBR, 'pt-BR') },
  en: { translation: withSpeakerLabels(en, 'en') },
  es: { translation: withSpeakerLabels(es, 'es') }
} as const

/** Idioma escolhido nas configurações ou, sem escolha, o do sistema (pt*, es*, senão inglês). */
export function resolveLanguage(setting: UiLanguage | null, system: string): UiLanguage {
  if (setting !== null) return setting
  const lower = system.toLowerCase()
  if (lower.startsWith('pt')) return 'pt-BR'
  return lower.startsWith('es') ? 'es' : 'en'
}

export function createI18n(language: UiLanguage): i18n {
  const instance = i18next.createInstance()
  void instance.use(initReactI18next).init({
    resources: RESOURCES,
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false }, // o React já escapa
    initAsync: false
  })
  return instance
}
