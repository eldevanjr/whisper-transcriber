import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiveSettings, useSaveLive } from '../../hooks/useSaveLive'

/** Pausa que fecha um trecho (0,5–3,0 s), salva na hora. */
export function PauseSlider({ disabled = false }: { disabled?: boolean }) {
  const { t, i18n } = useTranslation()
  const id = useId()
  const { pauseS } = useLiveSettings()
  const save = useSaveLive()
  const value = pauseS.toLocaleString(i18n.language, { minimumFractionDigits: 1 })
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t('live.pause')}
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0.5}
          max={3}
          step={0.1}
          value={pauseS}
          disabled={disabled}
          onChange={(event) =>
            void save({ pauseS: Math.round(Number(event.target.value) * 10) / 10 })
          }
          className="w-64 accent-accent-solid"
        />
        <output htmlFor={id} className="text-sm tabular-nums">
          {t('live.pauseValue', { value })}
        </output>
      </div>
      <p className="text-xs text-muted">{t('live.pauseHint')}</p>
    </div>
  )
}
