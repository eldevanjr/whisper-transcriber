import { Volume2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MonitorVolume } from '../../../../shared/ipc'
import { Button } from '../../components/Button'
import { useApi, useAppStore } from '../../providers'

/** Abaixo disso a fala dos "Outros" chega fraca demais para transcrever. */
export const MONITOR_LOW_PERCENT = 50
const POLL_MS = 5000
const SAVE_DELAY_MS = 250

export function isMonitorLow(volume: MonitorVolume): boolean {
  return volume.muted || volume.percent < MONITOR_LOW_PERCENT
}

/**
 * Volume do monitor da saída padrão (só Linux; null nos outros sistemas). Com `watch`, relê de
 * tempos em tempos: outro programa pode baixá-lo no meio da sessão.
 */
export function useMonitorVolume(watch = false) {
  const api = useApi()
  const [volume, setVolume] = useState<MonitorVolume | null>(null)
  useEffect(() => {
    let active = true
    const read = (): void => {
      void api.live.monitorVolume().then((next) => {
        if (active) setVolume(next)
      })
    }
    read()
    const timer = watch ? setInterval(read, POLL_MS) : null
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [api, watch])
  const set = useCallback(
    async (percent: number) => {
      setVolume(await api.live.setMonitorVolume(percent))
    },
    [api]
  )
  return { volume, set }
}

/** Configurações: quanto do som da saída chega à gravação dos "Outros". */
export function MonitorVolumeSlider({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation()
  const id = useId()
  const { volume, set } = useMonitorVolume()
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  if (!volume) return null
  const value = draft ?? (volume.muted ? 0 : volume.percent)
  const change = (percent: number): void => {
    setDraft(percent)
    if (timer.current) clearTimeout(timer.current)
    // Um pw-cli por ajuste, não um por pixel arrastado.
    timer.current = setTimeout(() => {
      void set(percent).finally(() => {
        setDraft(null)
      })
    }, SAVE_DELAY_MS)
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {t('live.monitorVolume')}
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            change(Number(event.target.value))
          }}
          className="w-64 accent-accent-solid"
        />
        <output htmlFor={id} className="text-sm tabular-nums">
          {t('live.monitorVolumeValue', { value })}
        </output>
      </div>
      <p className="text-xs text-muted">{t('live.monitorVolumeHint', { sink: volume.sink })}</p>
      {draft === null && isMonitorLow(volume) && (
        <p className="text-xs text-danger">{t('live.monitorLowShort')}</p>
      )}
    </div>
  )
}

function MonitorLow({
  volume,
  set
}: {
  volume: MonitorVolume
  set: (percent: number) => Promise<void>
}) {
  const { t } = useTranslation()
  const [fixing, setFixing] = useState(false)
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-danger-soft p-4 text-sm"
    >
      <p className="font-medium text-danger">
        {t(volume.muted ? 'live.monitorMuted' : 'live.monitorLow', { value: volume.percent })}
      </p>
      <p className="text-muted">{t('live.monitorLowHint', { sink: volume.sink })}</p>
      <div>
        <Button
          size="sm"
          disabled={fixing}
          onClick={() => {
            setFixing(true)
            void set(100).finally(() => {
              setFixing(false)
            })
          }}
        >
          <Volume2 aria-hidden size={16} />
          {t('live.monitorFix')}
        </Button>
      </div>
    </div>
  )
}

/** Abaixo disso (−60 dB, o piso do medidor) o bloco conta como silêncio. */
const SIGNAL_RMS = 0.001
export const NO_SIGNAL_WARN_MS = 15_000

/**
 * Se nada acima do silêncio chegou desde que a faixa abriu, depois de um tempo. Só o começo:
 * silêncio no meio da conversa é normal; captura quebrada nunca manda som.
 */
function useNeverHeard(level: number): boolean {
  const [heard, setHeard] = useState(false)
  const [waited, setWaited] = useState(false)
  if (!heard && level > SIGNAL_RMS) setHeard(true)
  useEffect(() => {
    const timer = setTimeout(() => {
      setWaited(true)
    }, NO_SIGNAL_WARN_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [])
  return waited && !heard
}

function NoSignal() {
  const { t } = useTranslation()
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  return (
    <div role="status" className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2 text-sm">
      <p>{t('live.noSignal', { seconds: NO_SIGNAL_WARN_MS / 1000 })}</p>
      <p className="text-xs text-muted">{t('live.noSignalHint')}</p>
      {platform === 'darwin' && <p className="text-xs text-muted">{t('live.noSignalHintMac')}</p>}
    </div>
  )
}

/**
 * Ao vivo, com a faixa dos "Outros" aberta: avisa quando ela vai chegar muda. No Linux o volume
 * do monitor diz o motivo e corrige com um clique; em qualquer sistema, a falta de som avisa.
 * Montar de novo (a captura reabriu) zera a espera.
 */
export function SystemAudioWarning({ level }: { level: number }) {
  const { volume, set } = useMonitorVolume(true)
  const neverHeard = useNeverHeard(level)
  if (volume && isMonitorLow(volume)) return <MonitorLow volume={volume} set={set} />
  return neverHeard ? <NoSignal /> : null
}
