import { Plug, Settings as SettingsIcon, Square } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import { Button, IconButton } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Logo } from '../../components/Logo'
import { ProgressBar } from '../../components/Progress'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useAppStore } from '../../providers'
import type { Progress } from '../../store/app-store'
import type { Track } from '../../../../shared/settings'

const TRACK_NAME: Record<Track, string> = { voce: 'live.you', outros: 'live.others' }

/** Refazer do ao vivo: as faixas que ainda faltam têm a mesma duração da atual. */
function remainingS(progress: Progress): number {
  const later = progress.pass ? progress.pass.count - progress.pass.index - 1 : 0
  return (progress.totalS - progress.processedS + later * progress.totalS) / progress.speed
}

function Times({ progress }: { progress: Progress }) {
  const { t, i18n } = useTranslation()
  const remaining = progress.speed > 0 ? remainingS(progress) : null
  const { pass } = progress
  const speed = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(progress.speed)
  return (
    <span className="flex gap-3 text-xs whitespace-nowrap text-muted tabular-nums">
      {pass && (
        <span>
          {t('main.trackPass', {
            name: t(TRACK_NAME[pass.track]),
            n: pass.index + 1,
            count: pass.count
          })}
        </span>
      )}
      <span>
        {t('main.progressTimes', {
          processed: formatTime(progress.processedS),
          total: formatTime(progress.totalS)
        })}
      </span>
      {remaining !== null && <span>{t('main.remaining', { time: formatTime(remaining) })}</span>}
      <span>{speed}×</span>
    </span>
  )
}

function CurrentJob({ jobId }: { jobId: string }) {
  const { t } = useTranslation()
  const actions = useQueueActions()
  const fileName = useAppStore((s) => s.entries[jobId]?.fileName ?? '')
  const live = useAppStore((s) => s.live[jobId])
  const [confirming, setConfirming] = useState(false)
  const phase = live?.phase ?? 'waiting'

  return (
    <div className="flex min-w-0 flex-1 items-center gap-4" aria-live="polite">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="truncate font-medium">{fileName}</span>
          <span className="text-muted">{t(`main.phase.${phase}`)}</span>
        </span>
        <ProgressBar
          label={t(phase === 'extracting_audio' ? 'main.progressExtract' : 'main.progress')}
          value={live?.progress?.pct ?? 0}
        />
      </div>
      {live?.progress && <Times progress={live.progress} />}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setConfirming(true)
        }}
      >
        <Square aria-hidden size={14} />
        {t('main.cancel')}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t('main.cancelTitle')}
        message={t('main.cancelMessage')}
        confirmLabel={t('main.cancel')}
        cancelLabel={t('main.keep')}
        destructive
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => {
          setConfirming(false)
          void actions.cancel()
        }}
      />
    </div>
  )
}

export function TopBar() {
  const { t } = useTranslation()
  const current = useAppStore((s) => s.queue.current)
  const openSettings = useAppStore((s) => s.openSettings)
  return (
    <header className="flex h-16 items-center gap-6 border-b border-line bg-surface px-4">
      <span className="flex shrink-0 items-center gap-2 font-semibold">
        <Logo size={28} />
        {t('app.name')}
      </span>
      {current === null ? <span className="flex-1" /> : <CurrentJob jobId={current} />}
      <IconButton
        label={t('main.connectAi')}
        icon={Plug}
        onClick={() => {
          openSettings('ai')
        }}
      />
      <IconButton
        label={t('main.settings')}
        icon={SettingsIcon}
        onClick={() => {
          openSettings()
        }}
      />
    </header>
  )
}
