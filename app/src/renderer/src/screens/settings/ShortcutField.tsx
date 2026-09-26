import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAccelerator } from '../../../../shared/accelerator'
import type { ShortcutStatus } from '../../../../shared/ipc'
import { DEFAULT_SHORTCUT } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { useSaveTray, useTraySettings } from '../../hooks/useSaveTray'
import { acceleratorFromKeys } from '../../lib/accelerator'
import { useApi, useAppStore } from '../../providers'

function useShortcutStatus(shortcut: string | null): ShortcutStatus | null {
  const api = useApi()
  const [status, setStatus] = useState<ShortcutStatus | null>(null)
  useEffect(() => {
    let active = true
    void api.background.shortcutStatus().then((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
    }
  }, [api, shortcut])
  return status
}

/** Atalho de começar/parar: clique, pressione a combinação; o atual fica suspenso enquanto isso. */
export function ShortcutField() {
  const { t } = useTranslation()
  const api = useApi()
  const hintId = useId()
  const { shortcut } = useTraySettings()
  const save = useSaveTray()
  const platform = useAppStore((s) => s.appInfo?.platform ?? '')
  const status = useShortcutStatus(shortcut)
  const [recording, setRecording] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const suspended = useRef(false)
  const current = shortcut ? formatAccelerator(shortcut, platform) : t('live.shortcutNone')

  const listen = (on: boolean): void => {
    suspended.current = on
    setRecording(on)
    setInvalid(false)
    void api.background.suspendShortcut(on)
  }

  useEffect(() => {
    return () => {
      // Sair da tela sem blur (navegação, janela escondida): o atalho não pode ficar suspenso.
      if (suspended.current) void api.background.suspendShortcut(false)
    }
  }, [api])
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    event.preventDefault()
    if (event.key === 'Escape') {
      listen(false)
      return
    }
    const accelerator = acceleratorFromKeys(event, platform)
    if (accelerator === 'pending') return
    if (accelerator === null) {
      setInvalid(true)
      return
    }
    listen(false)
    void save({ shortcut: accelerator })
  }

  return (
    <div className="flex flex-col gap-2">
      <p id={hintId} className="text-xs text-muted">
        {t('live.shortcutHint')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={t('live.shortcutRecord', { current })}
          aria-describedby={hintId}
          onClick={() => {
            listen(true)
          }}
          onBlur={() => {
            if (recording) listen(false)
          }}
          onKeyDown={onKeyDown}
          className="h-10 min-w-44 rounded-lg border border-line bg-surface px-3 font-mono text-sm"
        >
          {recording ? t('live.shortcutRecording') : current}
        </button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void save({ shortcut: DEFAULT_SHORTCUT })}
        >
          {t('live.shortcutDefault')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={shortcut === null}
          onClick={() => void save({ shortcut: null })}
        >
          {t('live.shortcutOff')}
        </Button>
      </div>
      {invalid && (
        <p role="alert" className="text-xs text-danger">
          {t('live.shortcutNeedsModifier')}
        </p>
      )}
      {status === 'taken' && <p className="text-xs text-danger">{t('live.shortcutTaken')}</p>}
      {status === 'unavailable' && (
        <p className="text-xs text-danger">{t('live.shortcutUnavailable')}</p>
      )}
    </div>
  )
}
