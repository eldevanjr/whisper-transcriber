import type { UI_LANGUAGES } from './settings'

export type UiLanguage = (typeof UI_LANGUAGES)[number]

/** Idioma escolhido nas configurações ou, sem escolha, o do sistema (pt*, es*, senão inglês). */
export function resolveLanguage(setting: UiLanguage | null, system: string): UiLanguage {
  if (setting !== null) return setting
  const lower = system.toLowerCase()
  if (lower.startsWith('pt')) return 'pt-BR'
  return lower.startsWith('es') ? 'es' : 'en'
}
