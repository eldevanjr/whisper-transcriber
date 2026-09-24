import { useTranslation } from 'react-i18next'

const FLOOR_DB = -60 // abaixo disso o medidor fica vazio

/** Nível em escala de decibéis: a voz normal (RMS ~0,05–0,3) fica no meio para cima. */
export function levelPercent(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6))
  return Math.round(Math.min(1, Math.max(0, 1 - db / FLOOR_DB)) * 100)
}

export function LevelMeter({ label, level }: { label: string; level: number }) {
  const { t } = useTranslation()
  const pct = levelPercent(level)
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-xs text-muted">{label}</span>
      <div
        role="meter"
        aria-label={t('live.level', { name: label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent-solid transition-[width] duration-100"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
