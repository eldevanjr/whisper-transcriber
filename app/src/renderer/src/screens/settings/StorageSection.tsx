import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StorageStats } from '../../../../shared/history'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { SettingsCard } from '../../components/Fields'
import { useGuard } from '../../hooks/useGuard'
import { formatBytes } from '../../lib/bytes'
import { useApi, useAppStore } from '../../providers'

interface Usage {
  models: number
  cuda: number
  history: StorageStats
}

export function StorageSection() {
  const { t, i18n } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const refreshHistory = useAppStore((s) => s.refreshHistory)
  const pushNotice = useAppStore((s) => s.pushNotice)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [confirming, setConfirming] = useState(false)

  const load = useCallback(() => {
    void Promise.all([api.models.status(), api.cuda.status(), api.history.stats()]).then(
      ([models, cuda, history]) => {
        const modelBytes = models.installed.reduce((total, id) => total + models.sizes[id], 0)
        setUsage({ models: modelBytes, cuda: cuda.installed ? cuda.sizeBytes : 0, history })
      }
    )
  }, [api])
  useEffect(load, [load])

  if (!usage) return null
  const bytes = (value: number): string => formatBytes(value, i18n.language)
  const rows = [
    { label: t('settings.storage.models'), value: usage.models },
    { label: t('settings.storage.cuda'), value: usage.cuda },
    {
      label: t('settings.storage.history', { count: usage.history.count }),
      value: usage.history.bytes
    }
  ]

  const clear = async (): Promise<void> => {
    setConfirming(false)
    const ok = await guard(() => api.history.clear())
    if (!ok) return
    pushNotice({ kind: 'info', key: 'settings.storage.cleared' })
    await refreshHistory()
    load()
  }

  return (
    <SettingsCard title={t('settings.sections.storage')}>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted">{row.label}</dt>
            <dd className="text-right tabular-nums">{bytes(row.value)}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void api.system.openDataFolder()}>
          {t('settings.storage.openFolder')}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            setConfirming(true)
          }}
        >
          {t('settings.storage.clear')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t('settings.storage.clearTitle')}
        message={t('settings.storage.clearMessage', {
          count: usage.history.count,
          size: bytes(usage.history.bytes)
        })}
        confirmLabel={t('settings.storage.clearConfirm')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => {
          setConfirming(false)
        }}
        onConfirm={() => void clear()}
      />
    </SettingsCard>
  )
}
