import { useTranslation } from 'react-i18next'
import { clientDisplayName, type McpActivityLine } from '../../../../../shared/mcp'
import { formatRelative } from '../../../lib/relative-time'

/** A tela mostra no máximo 50 linhas (spec §10.2); o log guarda 500. */
const MAX_LINES = 50

export interface RecentActivityProps {
  lines: McpActivityLine[]
  now: number
}

/** "Claude Code · leu 'Reunião 12/09 14:00' · há 3 min"; vazio: "Nenhuma IA usou ainda." */
export function RecentActivity({ lines, now }: RecentActivityProps) {
  const { t, i18n } = useTranslation()
  if (lines.length === 0) {
    return <p className="text-sm text-muted">{t('settings.ai.activity.empty')}</p>
  }
  return (
    <ul aria-label={t('settings.ai.activity.title')} className="flex flex-col gap-1 text-sm">
      {lines.slice(0, MAX_LINES).map((line, index) => (
        <li key={`${line.at}-${String(index)}`} className="truncate">
          {t(
            line.title === undefined
              ? 'settings.ai.activity.line'
              : 'settings.ai.activity.lineWithTitle',
            {
              client: clientDisplayName(line.client),
              tool: t(`settings.ai.activity.tools.${line.tool}`, { defaultValue: line.tool }),
              title: line.title ?? '',
              time: formatRelative(line.at, now, i18n.language)
            }
          )}
        </li>
      ))}
    </ul>
  )
}
