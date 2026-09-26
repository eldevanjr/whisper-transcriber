import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpStatus } from '../../../../shared/ipc'
import type { ClientStatus, ClientStatusError, McpClientId } from '../../../../shared/mcp'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { SettingsCard } from '../../components/Fields'
import { Toggle } from '../../components/Toggle'
import { useCopy } from '../../hooks/useCopy'
import { useMcpStatus, type McpTestState } from '../../hooks/useMcpStatus'
import { useSaveSettings } from '../../hooks/useSaveSettings'
import { useAppStore } from '../../providers'
import { ClientCard } from './ai/ClientCard'
import { RecentActivity } from './ai/RecentActivity'

function statusLine(
  t: TFunction,
  status: McpStatus | null,
  enabled: boolean,
  connected: number
): string {
  if (status?.launcherError)
    return t('settings.ai.access.problem', { reason: status.launcherError })
  if (!enabled) return t('settings.ai.access.off')
  return t('settings.ai.access.ready', { count: connected })
}

function clientsOf(status: McpStatus | null): ClientStatus[] {
  return status ? status.clients : []
}

function launcherPathOf(status: McpStatus | null): string {
  return status ? status.launcherPath : ''
}

function errorFor(
  errors: Partial<Record<McpClientId, ClientStatusError>>,
  client: ClientStatus
): ClientStatusError | undefined {
  return errors[client.id] ?? client.error
}

function testLine(t: TFunction, test: McpTestState): string | null {
  if (test.status === 'ok') return t('settings.ai.access.testOk', { count: test.tools })
  if (test.status === 'error') {
    return t('settings.ai.access.testError', { message: test.error.message })
  }
  return null
}

function CopyBlock({
  label,
  value,
  copyLabel
}: {
  label: string
  value: string
  copyLabel: string
}) {
  const { t } = useTranslation()
  const { copied, copy } = useCopy()
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
        {value}
      </pre>
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        aria-label={copyLabel}
        onClick={() => void copy(value)}
      >
        {copied ? t('settings.ai.clients.copied') : t('settings.ai.clients.copy')}
      </Button>
    </div>
  )
}

/** Seção "IAs (MCP)" das configurações (spec §10). */
export function AiSection({ now = Date.now }: { now?: () => number } = {}) {
  const { t } = useTranslation()
  const settings = useAppStore((s) => s.settings)
  const save = useSaveSettings()
  const mcp = useMcpStatus()
  const [pending, setPending] = useState<McpClientId | null>(null)
  if (!settings) return null

  const enabled = settings.mcp.enabled
  const clients = clientsOf(mcp.status)
  const connected = clients.filter((item) => item.state === 'connected').length
  const launcherPath = launcherPathOf(mcp.status)
  const genericJson = JSON.stringify(
    { mcpServers: { 'whisper-transcriber': { command: launcherPath, args: [] } } },
    null,
    2
  )

  const status = statusLine(t, mcp.status, enabled, connected)
  const result = testLine(t, mcp.test)

  const requestConnect = (id: McpClientId): void => {
    if (enabled) void mcp.connect(id)
    else setPending(id)
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t('settings.ai.intro')}</p>

      <SettingsCard title={t('settings.ai.access.title')}>
        <Toggle
          label={t('settings.ai.access.enabled')}
          checked={enabled}
          onChange={(value) => void save({ mcp: { ...settings.mcp, enabled: value } })}
        />
        <Toggle
          label={t('settings.ai.access.transcribe')}
          checked={settings.mcp.allowTranscribe}
          disabled={!enabled}
          onChange={(value) => void save({ mcp: { ...settings.mcp, allowTranscribe: value } })}
        />
        <p className="text-sm">{status}</p>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            disabled={mcp.test.status === 'testing'}
            onClick={() => void mcp.runTest()}
          >
            {t(
              mcp.test.status === 'testing'
                ? 'settings.ai.access.testing'
                : 'settings.ai.access.test'
            )}
          </Button>
          {result && <span className="text-sm text-muted">{result}</span>}
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.ai.clients.title')}>
        <ul aria-label={t('settings.ai.clients.title')} className="flex flex-col gap-3">
          {clients.map((item) => (
            <ClientCard
              key={item.id}
              client={item}
              busy={mcp.busy === item.id}
              error={errorFor(mcp.errors, item)}
              now={now()}
              onConnect={requestConnect}
              onDisconnect={(id) => void mcp.disconnect(id)}
            />
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard title={t('settings.ai.other.title')}>
        <p className="text-sm text-muted">{t('settings.ai.other.description')}</p>
        <CopyBlock
          label={t('settings.ai.other.command')}
          value={launcherPath}
          copyLabel={t('settings.ai.other.copyCommand')}
        />
        <CopyBlock
          label={t('settings.ai.other.json')}
          value={genericJson}
          copyLabel={t('settings.ai.other.copyJson')}
        />
      </SettingsCard>

      <SettingsCard title={t('settings.ai.web.title')}>
        <p className="text-sm text-muted">{t('settings.ai.web.description')}</p>
      </SettingsCard>

      <SettingsCard title={t('settings.ai.activity.title')}>
        <RecentActivity lines={mcp.activity} now={now()} />
      </SettingsCard>

      {pending !== null && (
        <ConfirmDialog
          open
          title={t('settings.ai.confirm.title')}
          message={t('settings.ai.confirm.message')}
          confirmLabel={t('settings.ai.confirm.confirm')}
          cancelLabel={t('settings.ai.confirm.cancel')}
          onCancel={() => {
            setPending(null)
          }}
          onConfirm={() => {
            const id = pending
            setPending(null)
            void mcp.connect(id)
          }}
        />
      )}
    </div>
  )
}
