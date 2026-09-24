import { Mic, Pause, Play, Square } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import { TRACKS, type Track } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { useInputDevices } from '../../hooks/useInputDevices'
import type { LiveController } from '../../hooks/useLiveCapture'
import { useAppStore } from '../../providers'
import type { LiveSessionState } from '../../store/app-store'
import { LevelMeter } from './LevelMeter'
import { MicSelect } from './LiveFields'
import { SystemAudioWarning } from './MonitorVolume'

const LAG_WARN_S = 3
const LAG_SUGGEST_S = 120
const NAME_KEY: Record<Track, string> = { voce: 'live.you', outros: 'live.others' }

/** Conversa em balões: Outros à esquerda, Você à direita; "ouvindo" para o trecho em captação. */
export function Bubbles({ session }: { session: LiveSessionState }) {
  const { t } = useTranslation()
  const listening = TRACKS.filter((track) => session.listening[track])
  return (
    <ol className="flex flex-col gap-2">
      {session.segments.map((segment, index) => (
        <li
          key={`${segment.track}-${segment.start}-${index}`}
          className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${segment.track === 'voce' ? 'self-end rounded-tr-sm bg-accent-soft' : 'self-start rounded-tl-sm bg-surface-2'}`}
        >
          <span className="block text-xs text-muted">
            {t(NAME_KEY[segment.track])} · {formatTime(segment.start)}
          </span>
          {segment.text}
        </li>
      ))}
      {listening.map((track) => (
        <li
          key={`listening-${track}`}
          className={`flex items-center gap-2 text-xs text-muted ${track === 'voce' ? 'self-end' : 'self-start'}`}
        >
          <span aria-hidden>···</span>
          {t('live.listening', { name: t(NAME_KEY[track]) })}
        </li>
      ))}
    </ol>
  )
}

function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      setSeconds((s) => s + 1)
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [running])
  return seconds
}

function Header({
  controller,
  session
}: {
  controller: LiveController
  session: LiveSessionState
}) {
  const { t } = useTranslation()
  const recording = session.state === 'recording'
  const stopping = session.state === 'stopping'
  const elapsed = useElapsed(recording)
  return (
    <header className="flex flex-wrap items-center gap-4 border-b border-line bg-surface px-6 py-3">
      <span
        className={`flex items-center gap-2 text-sm font-semibold ${recording ? 'text-danger' : 'text-muted'}`}
      >
        <span
          aria-hidden
          className={`size-2.5 rounded-full ${recording ? 'animate-pulse bg-danger' : 'bg-muted'}`}
        />
        {recording ? t('live.rec') : t('live.paused')}
      </span>
      <span role="timer" className="font-mono text-sm tabular-nums">
        {formatTime(elapsed)}
      </span>
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        {controller.tracks.map((track) => (
          <LevelMeter key={track} label={t(NAME_KEY[track])} level={controller.levels[track]} />
        ))}
      </div>
      {session.state === 'paused' ? (
        <Button
          variant="secondary"
          disabled={controller.deviceLost}
          onClick={() => void controller.resume()}
        >
          <Play aria-hidden size={16} />
          {t('live.resume')}
        </Button>
      ) : (
        <Button variant="secondary" disabled={stopping} onClick={() => void controller.pause()}>
          <Pause aria-hidden size={16} />
          {t('live.pauseSession')}
        </Button>
      )}
      <Button variant="danger" disabled={stopping} onClick={() => void controller.stop()}>
        <Square aria-hidden size={16} />
        {t(stopping ? 'live.stopping' : 'live.stop')}
      </Button>
    </header>
  )
}

function DeviceLost({ controller }: { controller: LiveController }) {
  const { t } = useTranslation()
  const devices = useInputDevices(controller.deviceLost)
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger-soft p-4 text-sm"
    >
      <p className="font-medium text-danger">{t('live.deviceLost')}</p>
      <p className="text-muted">{t('live.deviceLostHint')}</p>
      <MicSelect devices={devices} />
      <div>
        <Button size="sm" onClick={controller.reopen}>
          <Mic aria-hidden size={16} />
          {t('live.reconnect')}
        </Button>
      </div>
    </div>
  )
}

function Lag({ seconds }: { seconds: number }) {
  const { t } = useTranslation()
  if (seconds < LAG_WARN_S) return null
  return (
    <p role="status" className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
      {t('live.lag', { seconds: Math.round(seconds) })}
      {seconds > LAG_SUGGEST_S && (
        <span className="block text-xs text-muted">{t('live.lagHint')}</span>
      )}
    </p>
  )
}

/** Sessão: ● REC e tempo, medidores, Pausar/Retomar e Encerrar; a conversa rola sozinha. */
export function LiveSession({ controller }: { controller: LiveController }) {
  const { t } = useTranslation()
  const titleId = useId()
  const session = useAppStore((s) => s.liveSession)
  const list = useRef<HTMLElement>(null)
  const count = session.segments.length
  useEffect(() => {
    // O efeito roda depois de montar: a ref já existe (o `!` é proibido no projeto).
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    const element = list.current as HTMLElement
    element.scrollTop = element.scrollHeight
  }, [count])
  return (
    <div className="flex h-full flex-col">
      <Header controller={controller} session={session} />
      <main ref={list} className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {controller.deviceLost && <DeviceLost controller={controller} />}
          {controller.tracks.includes('outros') && (
            <SystemAudioWarning level={controller.levels.outros} />
          )}
          <Lag seconds={session.lag} />
          <h2 id={titleId} className="text-sm font-semibold tracking-wide text-muted uppercase">
            {t('live.conversation')}
          </h2>
          {count === 0 && <p className="text-sm text-muted">{t('live.empty')}</p>}
          <div role="log" aria-labelledby={titleId} aria-live="polite">
            <Bubbles session={session} />
          </div>
        </div>
      </main>
    </div>
  )
}
