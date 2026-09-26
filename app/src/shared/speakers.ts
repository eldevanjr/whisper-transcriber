import type { SpeakerLabels } from './format'
import { UI_LANGUAGES } from './settings'

export type UiLanguage = (typeof UI_LANGUAGES)[number]

/**
 * Rótulos dos falantes do ao vivo na língua da interface (`Você`/`You`/`Tú`).
 * Fonte única: o renderer monta o i18n com eles e o processo MCP usa direto (spec §9.3).
 */
export const SPEAKER_LABELS: Record<UiLanguage, SpeakerLabels> = {
  'pt-BR': { voce: 'Você', outros: 'Outros' },
  en: { voce: 'You', outros: 'Others' },
  es: { voce: 'Tú', outros: 'Otros' }
}

/** Rótulos de um idioma de interface já resolvido. */
export function speakerLabelsFor(language: UiLanguage): SpeakerLabels {
  return SPEAKER_LABELS[language]
}

/**
 * Idioma do usuário: a configuração vence; sem ela, segue o locale do sistema pelo prefixo
 * (pt→pt-BR, es→es, en→en). Desconhecido ou ausente → pt-BR, o idioma primário do app
 * (`DEFAULT_SETTINGS.uiLanguage` é `null`, mas os textos-base e o público principal são pt-BR).
 */
export function resolveSpeakerLabels(setting: UiLanguage | null, system?: string): SpeakerLabels {
  if (setting !== null) return speakerLabelsFor(setting)
  const lower = (system ?? '').toLowerCase()
  if (lower.startsWith('pt')) return speakerLabelsFor('pt-BR')
  if (lower.startsWith('es')) return speakerLabelsFor('es')
  if (lower.startsWith('en')) return speakerLabelsFor('en')
  return speakerLabelsFor('pt-BR')
}
