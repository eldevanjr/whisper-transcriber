import i18next, { type i18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { UI_LANGUAGES } from '../../../shared/settings'
import en from './en.json'
import es from './es.json'
import ptBR from './pt-BR.json'

export type UiLanguage = (typeof UI_LANGUAGES)[number]

export const RESOURCES = {
  'pt-BR': { translation: ptBR },
  en: { translation: en },
  es: { translation: es }
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
