import { Cpu } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Explica por que não há aceleração por GPU (em vez de esconder a opção). */
export function GpuUnavailable({ reason }: { reason: 'noGpu' | 'unsupported' }) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm">
      <Cpu aria-hidden size={20} className="mt-0.5 shrink-0 text-muted" />
      <div>
        <p className="font-medium">{t('gpu.unavailable.title')}</p>
        <p className="text-muted">{t(`gpu.unavailable.${reason}`)}</p>
      </div>
    </div>
  )
}
