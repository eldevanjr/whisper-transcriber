import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ErrorInfo } from '../../../shared/errors'
import type { HistoryMeta } from '../../../shared/history'
import type { BackgroundCommand } from '../../../shared/ipc'
import type { Track } from '../../../shared/settings'
import { errorInfoOf } from '../errors'
import type { Capture, CaptureEvent } from '../live/capture'
import { useApi, useAppStore, useAppStoreApi, useLiveMedia } from '../providers'
import { useGuard } from './useGuard'
import { useLiveSettings } from './useSaveLive'
import { useLiveSupport, type SystemAudioSupport } from './useLiveSupport'

const SILENT: Record<Track, number> = { voce: 0, outros: 0 }

export interface LiveController {
  support: SystemAudioSupport | null
  /** Faixas da captura aberta (medidores funcionando); vazio enquanto abre ou se falhou. */
  tracks: Track[]
  levels: Record<Track, number>
  error: ErrorInfo | null
  deviceLost: boolean
  reopen: () => void
  start: (test: boolean) => Promise<void>
  stop: () => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
}

function useSessionTitle(): () => string {
  const { t, i18n } = useTranslation()
  return useCallback(() => {
    const date = new Intl.DateTimeFormat(i18n.language, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date())
    return t('live.defaultTitle', { date })
  }, [i18n.language, t])
}

/**
 * Abre a captura assim que a tela aparece (os medidores funcionam antes de começar) e a reabre
 * quando o microfone ou o áudio do computador mudam. Os blocos só vão ao main durante a sessão.
 */
export function useLiveCapture(): LiveController {
  const api = useApi()
  const media = useLiveMedia()
  const guard = useGuard()
  const live = useLiveSettings()
  const support = useLiveSupport()
  const select = useAppStore((s) => s.select)
  const closeLive = useAppStore((s) => s.closeLive)
  const view = useAppStore((s) => s.view)
  const sessionState = useAppStore((s) => s.liveSession.state)
  const openLive = useAppStore((s) => s.openLive)
  const store = useAppStoreApi()
  const title = useSessionTitle()
  const [tracks, setTracks] = useState<Track[]>([])
  const [levels, setLevels] = useState(SILENT)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const [deviceLost, setDeviceLost] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const sending = useRef(false)
  const inSession = useRef(false)
  const deviceLostRef = useRef(false) // espelho do estado: os comandos leem na hora, sem render
  // O microfone abre só com a tela do ao vivo ou durante a sessão (na bandeja fica fechado).
  const needed = view === 'live' || sessionState !== 'idle'
  const armed = useRef(false) // a bandeja pediu para começar assim que a captura abrir

  const onCaptureEvent = useCallback(
    (event: CaptureEvent): void => {
      if (event.type === 'block') {
        setLevels((previous) => ({ ...previous, [event.track]: event.rms }))
        if (sending.current) api.live.sendAudio(event.track, event.seq, event.pcm)
        return
      }
      setDeviceLost(true)
      deviceLostRef.current = true
      setLevels((previous) => ({ ...previous, [event.track]: 0 }))
      if (sending.current) {
        sending.current = false
        void guard(() => api.live.pause())
        void api.background.report({ kind: 'deviceLost' })
      }
    },
    [api, guard]
  )

  const startFromTray = useEffectEvent(async (opened: Track[]) => {
    try {
      await api.live.start({ tracks: opened, test: false, title: title() })
      inSession.current = true
      sending.current = true
    } catch (failure) {
      void api.background.report({ kind: 'startFailed', error: errorInfoOf(failure) })
    }
  })

  const onOpened = useEffectEvent((opened: Track[]) => {
    if (!armed.current) return
    armed.current = false
    void startFromTray(opened)
  })

  const onOpenFailed = useEffectEvent((info: ErrorInfo) => {
    if (!armed.current) return
    armed.current = false
    void api.background.report({ kind: 'startFailed', error: info })
  })

  useEffect(() => {
    if (support === null || !needed) return
    let active = true
    let opened: Capture | null = null
    const options = { micDeviceId: live.micDeviceId, systemAudio: live.systemAudio, support }
    media.start(options).then(
      (started) => {
        if (!active) return void started.stop()
        opened = started
        started.onEvent(onCaptureEvent)
        setError(null)
        setDeviceLost(false)
        deviceLostRef.current = false
        setLevels(SILENT)
        setTracks(started.tracks)
        onOpened(started.tracks)
      },
      (failure: unknown) => {
        if (!active) return
        const info = errorInfoOf(failure)
        setError(info)
        onOpenFailed(info)
      }
    )
    return () => {
      active = false
      setTracks([])
      void opened?.stop()
    }
  }, [media, support, live.micDeviceId, live.systemAudio, attempt, onCaptureEvent, needed])

  // Saiu da tela no meio da sessão: encerra (o main finaliza a gravação).
  useEffect(
    () => () => {
      if (inSession.current) void api.live.stop()
    },
    [api]
  )

  const start = useCallback(
    async (test: boolean) => {
      await guard(async () => {
        await api.live.start({ tracks, test, title: title() })
        inSession.current = true
        sending.current = true
      })
    },
    [api, tracks, guard, title]
  )

  const stop = useCallback(async () => {
    sending.current = false
    inSession.current = false
    const result: { meta: HistoryMeta | null } = { meta: null }
    await guard(async () => {
      result.meta = await api.live.stop()
    })
    if (!result.meta) return // teste (sem item) ou falha: continua na tela
    select(result.meta.id)
    closeLive()
  }, [api, closeLive, guard, select])

  const pause = useCallback(async () => {
    sending.current = false
    await guard(() => api.live.pause())
  }, [api, guard])

  const resume = useCallback(async () => {
    sending.current = true
    await guard(() => api.live.resume())
  }, [api, guard])

  const reopen = useCallback(() => {
    setAttempt((n) => n + 1)
  }, [])

  const onToggle = useEffectEvent(() => {
    const state = store.getState().liveSession.state
    if (state === 'recording' || state === 'paused') {
      void stop()
      return
    }
    if (state !== 'idle') return // começando/parando: nada
    armed.current = true
    setError(null)
    setAttempt((n) => n + 1) // captura nova: o 1º "aberta" dela começa a sessão
    openLive()
  })

  const onCommand = useEffectEvent(({ action }: BackgroundCommand) => {
    const state = store.getState().liveSession.state
    if (action === 'pause') {
      if (state === 'recording') void pause()
      return
    }
    if (action === 'resume') {
      if (state === 'paused' && !deviceLostRef.current) void resume()
      return
    }
    onToggle()
  })

  useEffect(() => api.background.onCommand(onCommand), [api])

  return { support, tracks, levels, error, deviceLost, reopen, start, stop, pause, resume }
}
