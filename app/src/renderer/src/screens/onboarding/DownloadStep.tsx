import { Check, Circle, CircleX, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import { downloadKey } from '../../../../shared/events'
import { MODEL_CATALOG } from '../../../../shared/models'
import { Button } from '../../components/Button'
import { ErrorNotice } from '../../components/ErrorNotice'
import { ProgressRing } from '../../components/Progress'
import { useSetup, type Setup, type SetupStep, type StepStatus } from '../../hooks/useSetup'
import { formatBytes } from '../../lib/bytes'
import { transferRate } from '../../lib/rate'
import { useAppStore } from '../../providers'
import type { DownloadState } from '../../store/app-store'
import type { SetupChoice } from './ModelChoice'

const STATUS_ICON = { pending: Circle, active: LoaderCircle, done: Check, failed: CircleX }
const STATUS_TONE = {
  pending: 'text-muted',
  active: 'text-muted',
  done: 'text-accent',
  failed: 'text-danger'
}

function currentKey(choice: SetupChoice, setup: Setup): string {
  const { status } = setup
  if (status.cuda === 'active' || status.cuda === 'failed') return 'cuda'
  return downloadKey({ kind: 'model', id: choice.model, format: setup.format })
}

function StepLine({ label, status }: { label: string; status: StepStatus }) {
  const { t } = useTranslation()
  const Icon = STATUS_ICON[status]
  return (
    <li className="flex items-center gap-3 text-sm">
      <Icon
        aria-hidden
        size={16}
        className={`${STATUS_TONE[status]} ${status === 'active' ? 'animate-spin' : ''}`}
      />
      <span className="flex-1">{label}</span>
      <span className={STATUS_TONE[status]}>{t(`onboarding.download.status.${status}`)}</span>
    </li>
  )
}

function Numbers({ download }: { download: DownloadState }) {
  const { t, i18n } = useTranslation()
  const rate = transferRate(download.samples)
  return (
    <div className="text-center text-sm text-muted">
      <p>
        {t('onboarding.download.bytes', {
          received: formatBytes(download.received, i18n.language),
          total: formatBytes(download.total, i18n.language)
        })}
      </p>
      {rate > 0 && (
        <p>
          {t('onboarding.download.speed', {
            speed: formatBytes(rate, i18n.language),
            eta: formatTime((download.total - download.received) / rate)
          })}
        </p>
      )}
    </div>
  )
}

/** Mostra onde o download está (ou parou); concluído → 100%; ainda sem dados → 0%. */
function percent(download: DownloadState | undefined, finished: boolean): number {
  if (finished || download?.status === 'done') return 100
  return download && download.total > 0 ? (download.received / download.total) * 100 : 0
}

function FailureActions(props: { setup: Setup; gpu: boolean; onBack: () => void }) {
  const { t } = useTranslation()
  return (
    <>
      <Button size="sm" onClick={props.setup.retry}>
        {t('common.retry')}
      </Button>
      {props.gpu && props.setup.status.test === 'failed' && (
        <Button size="sm" variant="secondary" onClick={props.setup.useCpu}>
          {t('onboarding.download.useCpu')}
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={props.onBack}>
        {t('onboarding.download.back')}
      </Button>
    </>
  )
}

export function DownloadStep(props: {
  choice: SetupChoice
  onDone: () => void
  onBack: () => void
}) {
  const { choice, onDone } = props
  const { t } = useTranslation()
  const setup = useSetup(choice)
  const download = useAppStore((s) => s.downloads[currentKey(choice, setup)])

  const labels: Record<SetupStep, string> = {
    model: t('onboarding.download.stepModel', { model: MODEL_CATALOG[choice.model].label }),
    cuda: t('onboarding.download.stepCuda'),
    test: t('onboarding.download.stepTest')
  }

  return (
    <section className="flex w-full max-w-lg flex-col items-center gap-6" aria-live="polite">
      <h1 className="text-2xl font-semibold">{t('onboarding.download.title')}</h1>
      <ProgressRing
        label={t('onboarding.download.ring')}
        value={percent(download, setup.finished)}
      />
      {download?.status === 'active' && <Numbers download={download} />}
      <ul className="flex w-full flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        {setup.steps.map((step) => (
          <StepLine key={step} label={labels[step]} status={setup.status[step]} />
        ))}
      </ul>
      {setup.error && (
        <div className="w-full">
          <ErrorNotice
            error={setup.error}
            settingsAction={false}
            actions={
              <FailureActions setup={setup} gpu={choice.device !== 'cpu'} onBack={props.onBack} />
            }
          />
        </div>
      )}
      <p className="text-center text-xs text-muted">
        {t('onboarding.download.resume')} {t('onboarding.download.tip')}
      </p>
      <Button disabled={!setup.finished} onClick={onDone}>
        {t('onboarding.download.start')}
      </Button>
    </section>
  )
}
