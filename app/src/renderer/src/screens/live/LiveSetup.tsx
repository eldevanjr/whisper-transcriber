import { ArrowLeft, FlaskConical, Mic, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { micPermissionUrl } from '../../../../shared/app-info'
import type { ErrorInfo } from '../../../../shared/errors'
import { Button } from '../../components/Button'
import { ErrorNotice } from '../../components/ErrorNotice'
import { SettingsCard } from '../../components/Fields'
import { useInputDevices } from '../../hooks/useInputDevices'
import type { LiveController } from '../../hooks/useLiveCapture'
import { useLiveSettings } from '../../hooks/useSaveLive'
import { useApi, useAppStore } from '../../providers'
import { AudioLanguageField } from '../settings/TranscriptionSection'
import { LevelMeter } from './LevelMeter'
import { MicSelect, SystemAudioToggle } from './LiveFields'
import { Bubbles } from './LiveSession'
import { SystemAudioWarning } from './MonitorVolume'
import { PauseSlider } from './PauseSlider'

function CaptureError({ error, onRetry }: { error: ErrorInfo; onRetry: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const url = error.code === 'MIC_DENIED' ? micPermissionUrl(platform) : null
  return (
    <ErrorNotice
      error={error}
      actions={
        <>
          {url && (
            <Button size="sm" onClick={() => void api.system.openExternal(url)}>
              {t('live.permission')}
            </Button>
          )}
          <Button size="sm" onClick={onRetry}>
            {t('live.retry')}
          </Button>
        </>
      }
    />
  )
}

function Sources({ controller, locked }: { controller: LiveController; locked: boolean }) {
  const { t } = useTranslation()
  const { systemAudio } = useLiveSettings()
  const { tracks, levels, support } = controller
  const devices = useInputDevices(tracks)
  const wanted = systemAudio && support !== 'unavailable'
  const captured = tracks.includes('outros')
  return (
    <SettingsCard title={t('live.sources')}>
      <MicSelect devices={devices} />
      <LevelMeter label={t('live.you')} level={levels.voce} />
      <SystemAudioToggle support={support} disabled={locked} />
      {captured && <LevelMeter label={t('live.others')} level={levels.outros} />}
      {wanted && tracks.length > 0 && !captured && (
        <p className="text-xs text-muted">{t('live.systemNotNow')}</p>
      )}
      {captured && <SystemAudioWarning level={levels.outros} />}
    </SettingsCard>
  )
}

function Actions({ controller, testing }: { controller: LiveController; testing: boolean }) {
  const { t } = useTranslation()
  const busy = useAppStore((s) => s.queue.current !== null)
  const ready = controller.tracks.length > 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!ready}
          onClick={() => void (testing ? controller.stop() : controller.start(true))}
        >
          {testing ? <Square aria-hidden size={16} /> : <FlaskConical aria-hidden size={16} />}
          {t(testing ? 'live.stopTest' : 'live.test')}
        </Button>
        <Button disabled={!ready || busy || testing} onClick={() => void controller.start(false)}>
          <Mic aria-hidden size={16} />
          {t('live.start')}
        </Button>
      </div>
      {busy && <p className="text-xs text-muted">{t('live.busy')}</p>}
    </div>
  )
}

function Preview({ testing }: { testing: boolean }) {
  const { t } = useTranslation()
  const session = useAppStore((s) => s.liveSession)
  if (!testing && !(session.test && session.segments.length > 0)) return null
  return (
    <SettingsCard title={t('live.preview')}>
      <p className="text-xs text-muted">{t('live.testHint')}</p>
      <Bubbles session={session} />
    </SettingsCard>
  )
}

/** Preparar e testar: fontes com medidores, pausa, idioma, teste com prévia e Iniciar. */
export function LiveSetup({ controller }: { controller: LiveController }) {
  const { t } = useTranslation()
  const settings = useAppStore((s) => s.settings)
  const closeLive = useAppStore((s) => s.closeLive)
  const testing = useAppStore((s) => s.liveSession.test && s.liveSession.state !== 'idle')
  return (
    <main className="h-full overflow-auto p-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" disabled={testing} onClick={closeLive}>
            <ArrowLeft aria-hidden size={16} />
            {t('common.back')}
          </Button>
          <h1 className="text-2xl font-semibold">{t('live.title')}</h1>
        </div>
        {controller.error && <CaptureError error={controller.error} onRetry={controller.reopen} />}
        <Sources controller={controller} locked={testing} />
        <SettingsCard title={t('live.transcription')}>
          <PauseSlider disabled={testing} />
          {settings && <AudioLanguageField settings={settings} />}
        </SettingsCard>
        <Actions controller={controller} testing={testing} />
        <Preview testing={testing} />
      </div>
    </main>
  )
}
