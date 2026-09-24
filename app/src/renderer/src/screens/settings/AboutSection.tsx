import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { APP_AUTHOR, AUTHOR_GITHUB_URL } from '../../../../shared/app-info'
import { Button } from '../../components/Button'
import { Logo } from '../../components/Logo'
import { useApi, useAppStore } from '../../providers'

export function AboutSection() {
  const { t } = useTranslation()
  const api = useApi()
  const version = useAppStore((s) => s.appInfo?.version ?? '')
  const openSettings = useAppStore((s) => s.openSettings)
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-line bg-surface p-8 text-center">
      <Logo size={64} />
      <h2 className="text-2xl font-semibold">{t('app.name')}</h2>
      <p className="text-sm text-muted">{t('settings.about.version', { version })}</p>
      <p className="text-sm">
        {t('settings.about.madeBy')} <strong>{APP_AUTHOR}</strong>
      </p>
      <Button variant="secondary" onClick={() => void api.system.openExternal(AUTHOR_GITHUB_URL)}>
        <ExternalLink aria-hidden size={16} />
        github.com/eldevanjr
      </Button>
      <p className="max-w-md text-sm text-muted">{t('settings.about.license')}</p>
      <Button
        variant="ghost"
        onClick={() => {
          openSettings('licenses')
        }}
      >
        {t('settings.about.licenses')}
      </Button>
      <p className="max-w-md text-xs text-muted">{t('settings.about.disclaimer')}</p>
    </div>
  )
}
