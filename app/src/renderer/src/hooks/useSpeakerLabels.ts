import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpeakerLabels } from '../../../shared/format'
import { resolveSpeakerLabels } from '../../../shared/speakers'

/** "Você" e "Outros" no idioma da interface (trechos, textos copiados e baixados). */
export function useSpeakerLabels(): SpeakerLabels {
  const { i18n } = useTranslation()
  return useMemo(() => resolveSpeakerLabels(null, i18n.language), [i18n.language])
}
