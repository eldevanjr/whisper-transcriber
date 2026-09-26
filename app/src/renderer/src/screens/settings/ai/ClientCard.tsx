import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ClientStatus, ClientStatusError, McpClientId } from '../../../../../shared/mcp'
import { Button } from '../../../components/Button'
import { formatRelative } from '../../../lib/relative-time'
import { ManualConfig } from './ManualConfig'

export interface ClientCardProps {
  client: ClientStatus
  busy: boolean
  error?: ClientStatusError
  now: number
  onConnect: (id: McpClientId) => void
  onDisconnect: (id: McpClientId) => void
}

/** Linha de estado: "Conectado · usado há 3 min." / "Conectado · reinicie o … para usar". */
function stateLine(t: TFunction, client: ClientStatus, now: number, locale: string): string {
  const parts = [t(`settings.ai.clients.${client.state}`)]
  if (client.state === 'connected' && client.lastUsedAt !== null) {
    parts.push(
      t('settings.ai.clients.used', { time: formatRelative(client.lastUsedAt, now, locale) })
    )
  }
  if (client.restartNeeded) parts.push(t('settings.ai.clients.restart', { name: client.name }))
  return parts.join(' · ')
}

/** Texto do erro no cartão: os três casos traduzidos da spec §13, senão a mensagem crua. */
function errorText(t: TFunction, error: ClientStatusError, name: string): string {
  if (error.code === 'CONFIG_INVALID') return t('settings.ai.clients.configInvalid', { name })
  if (error.code === 'CONFIG_HAS_COMMENTS') {
    return t('settings.ai.clients.configHasComments', { name })
  }
  return error.message
}

function actionLabel(t: TFunction, client: ClientStatus, busy: boolean): string {
  if (client.state === 'connected') {
    return busy ? t('settings.ai.clients.disconnecting') : t('settings.ai.clients.disconnect')
  }
  return busy ? t('settings.ai.clients.connecting') : t('settings.ai.clients.connect')
}

export function ClientCard({ client, busy, error, now, onConnect, onDisconnect }: ClientCardProps) {
  const { t, i18n } = useTranslation()
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{client.name}</h3>
          <p className="text-xs text-muted">{stateLine(t, client, now, i18n.language)}</p>
        </div>
        {client.state !== 'missing' && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (client.state === 'connected') onDisconnect(client.id)
              else onConnect(client.id)
            }}
          >
            {actionLabel(t, client, busy)}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          {errorText(t, error, client.name)}
        </p>
      )}
      <ManualConfig config={client.manual} open={error !== undefined} />
    </li>
  )
}
