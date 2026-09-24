import { Info, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateInfo } from '../../../shared/events'
import { useApi, useAppStore } from '../providers'
import { Button, IconButton } from './Button'

function Banner({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 border-b border-line bg-accent-soft px-4 py-2 text-sm">
      <Info aria-hidden size={16} className="shrink-0 text-accent" />
      <div className="flex flex-1 flex-wrap items-center gap-3">{children}</div>
      <IconButton label={t('common.dismiss')} icon={X} onClick={onDismiss} />
    </div>
  )
}

/** Nova versão: link para a release, ou (modo automático) baixando → "Reiniciar para atualizar". */
function UpdateBanner(props: {
  update: UpdateInfo | null
  ready: string | null
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const api = useApi()
  if (props.ready) {
    return (
      <Banner onDismiss={props.onDismiss}>
        <span>{t('banners.updateReady', { version: props.ready })}</span>
        <Button size="sm" onClick={() => void api.updates.install()}>
          {t('banners.restart')}
        </Button>
      </Banner>
    )
  }
  if (!props.update) return null
  const { latest, url, mode } = props.update
  return (
    <Banner onDismiss={props.onDismiss}>
      {mode === 'auto' ? (
        <span>{t('banners.updateDownloading', { version: latest })}</span>
      ) : (
        <>
          <span>{t('banners.update', { version: latest })}</span>
          <Button size="sm" onClick={() => void api.system.openExternal(url)}>
            {t('banners.updateLink')}
          </Button>
        </>
      )}
    </Banner>
  )
}

export function Banners() {
  const { t } = useTranslation()
  const api = useApi()
  const checkUpdates = useAppStore((s) => s.settings?.checkUpdates ?? false)
  const recovered = useAppStore((s) => s.appInfo?.settingsRecovered ?? false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [ready, setReady] = useState<string | null>(null)
  const [recoveredOpen, setRecoveredOpen] = useState(true)

  useEffect(() => {
    if (!checkUpdates) return
    let active = true
    api.updates
      .check()
      .then((info) => {
        if (active && info?.available) setUpdate(info)
      })
      .catch(() => undefined) // sem internet: o aviso de versão é opcional
    return () => {
      active = false
    }
  }, [api, checkUpdates])

  useEffect(
    () =>
      api.updates.onEvent((event) => {
        setReady(event.version)
      }),
    [api]
  )

  const hasUpdate = update !== null || ready !== null
  if (!hasUpdate && !(recovered && recoveredOpen)) return null
  return (
    <section aria-label={t('app.name')}>
      <UpdateBanner
        update={update}
        ready={ready}
        onDismiss={() => {
          setUpdate(null)
          setReady(null)
        }}
      />
      {recovered && recoveredOpen && (
        <Banner
          onDismiss={() => {
            setRecoveredOpen(false)
          }}
        >
          <span>{t('banners.recovered')}</span>
        </Banner>
      )}
    </section>
  )
}
