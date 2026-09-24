import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpeakerLabels } from '../../../shared/format'

/** "Você" e "Outros" no idioma da interface (trechos, textos copiados e baixados). */
export function useSpeakerLabels(): SpeakerLabels {
  const { t } = useTranslation()
  return useMemo(() => ({ voce: t('live.you'), outros: t('live.others') }), [t])
}
