import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { buildDiagnostic, buildIssueUrl } from '../../../shared/diagnostics'
import type { ErrorInfo } from '../../../shared/errors'
import { errorAction } from '../errors'
import { useCopy } from '../hooks/useCopy'
import { useApi, useAppStore } from '../providers'
import { Button } from './Button'

/** Erro para o usuário: mensagem simples + ação + detalhes técnicos recolhidos + diagnóstico. */
export function ErrorNotice({
  error,
  actions,
  settingsAction = true
}: {
  error: ErrorInfo
  actions?: ReactNode
  /** Desligado no onboarding, onde as configurações ainda não existem. */
  settingsAction?: boolean
}) {
  const { t } = useTranslation()
  const api = useApi()
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const openSettings = useAppStore((s) => s.openSettings)
  const { copied, copy } = useCopy()
  const action = settingsAction ? errorAction(error.code) : null

  const diagnostic = (): string =>
    buildDiagnostic({ error, appInfo, settings, userAgent: navigator.userAgent })

  return (
    <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-4 text-sm">
      <p className="flex items-start gap-2 font-medium text-danger">
        <CircleAlert aria-hidden size={18} className="mt-0.5 shrink-0" />
        {t(`errors.${error.code}`)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {action && (
          <Button
            size="sm"
            onClick={() => {
              openSettings(action.section)
            }}
          >
            {t(action.key)}
          </Button>
        )}
        {actions}
        <Button size="sm" variant="secondary" onClick={() => void copy(diagnostic())}>
          {copied ? t('common.copied') : t('errors.copyDiagnostic')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void api.system.openExternal(
              buildIssueUrl(`${error.code}: ${error.message}`, diagnostic())
            )
          }
        >
          {t('errors.report')}
        </Button>
      </div>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">{t('errors.details')}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all">
          {`${error.code}: ${error.message}`}
          {error.detail === undefined ? '' : `\n${error.detail}`}
        </pre>
      </details>
    </div>
  )
}
