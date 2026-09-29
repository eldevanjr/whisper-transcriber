import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AiDiagnosticCheck,
  AiKnowledgeBackup,
  AiSecretKind,
  AiSecretsStatus
} from '../../../../shared/ipc'
import type { AiReindexProgress } from '../../../../shared/events'
import type { AiSettings, AiStorage, Settings, SettingsPatch } from '../../../../shared/settings'
import { STORAGE_MODES, type StorageMode } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import {
  CommitField,
  SelectField,
  SettingsCard,
  TextField,
  type Option
} from '../../components/Fields'
import { Toggle } from '../../components/Toggle'
import { useGuard } from '../../hooks/useGuard'
import { useCopy } from '../../hooks/useCopy'
import { useSaveSettings } from '../../hooks/useSaveSettings'
import { useApi } from '../../providers'

function withAi(ai: AiSettings, patch: Partial<AiSettings>): SettingsPatch {
  return { ai: { ...ai, ...patch } }
}

function parseNumber(raw: string): number | null {
  const value = raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Host do Ollama quando fica fora desta máquina (a transcrição sairia do computador). */
function remoteHost(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null // endereço inválido: o diagnóstico mostra o problema
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.')
  return loopback ? null : parsed.host
}

function TextRow(props: {
  label: string
  value: string
  hint?: string
  optional?: boolean
  onSave: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <CommitField
      label={props.label}
      value={props.value}
      hint={props.hint}
      validate={(raw) =>
        !props.optional && raw.trim() === '' ? t('settings.aiLocal.validation.required') : null
      }
      onCommit={(raw) => {
        props.onSave(raw.trim())
      }}
    />
  )
}

/** Campo de modelo do Ollama: editar o nome e baixar (pull) pela UI. */
function ModelRow(props: { label: string; value: string; onSave: (value: string) => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [pull, setPull] = useState<{ completed: number; total: number } | null>(null)

  useEffect(
    () =>
      api.ai.onEvent((event) => {
        if (event.type === 'pull' && event.model === props.value.trim()) {
          setPull({ completed: event.completed, total: event.total })
        }
      }),
    [api, props.value]
  )

  const download = async (): Promise<void> => {
    const model = props.value.trim()
    if (model === '') return
    setPull(null)
    setState('loading')
    const ok = await guard(() => api.ai.pullModel(model))
    setState(ok ? 'done' : 'idle')
  }

  const pullingPercent =
    pull === null || pull.total === 0 ? null : Math.round((pull.completed / pull.total) * 100)

  return (
    <div className="flex flex-col gap-2">
      <TextRow label={props.label} value={props.value} onSave={props.onSave} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={state === 'loading'}
          onClick={() => void download()}
        >
          {t(
            state === 'loading'
              ? 'settings.aiLocal.connection.pulling'
              : 'settings.aiLocal.connection.pull'
          )}
        </Button>
        {state === 'loading' && pullingPercent !== null && (
          <span role="status" className="text-xs text-muted">
            {t('settings.aiLocal.connection.pullingPercent', { percent: pullingPercent })}
          </span>
        )}
        {state === 'done' && (
          <span className="text-xs text-muted">
            {t('settings.aiLocal.connection.pulled', { model: props.value.trim() })}
          </span>
        )}
      </div>
    </div>
  )
}

function NumberRow(props: {
  label: string
  value: number
  min?: number
  step?: number
  hint?: string
  /** Regra que depende de outro campo (ex.: sobreposição menor que a janela). */
  check?: (value: number) => string | null
  onSave: (value: number) => void
}) {
  const { t } = useTranslation()
  return (
    <CommitField
      label={props.label}
      value={props.value}
      type="number"
      min={props.min}
      step={props.step}
      hint={props.hint}
      validate={(raw) => {
        const value = parseNumber(raw)
        if (value === null) return t('settings.aiLocal.validation.number')
        if (props.min !== undefined && value < props.min) {
          return t('settings.aiLocal.validation.min', { min: props.min })
        }
        return props.check?.(value) ?? null
      }}
      onCommit={(raw) => {
        props.onSave(Number(raw))
      }}
    />
  )
}

/** Campo de senha: guarda no cofre do SO, não nas settings. */
function SecretField(props: {
  label: string
  defined: boolean
  available: boolean
  onSave: (value: string) => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  return (
    <div className="flex flex-col gap-2">
      <TextField
        label={props.label}
        type="password"
        value={value}
        hint={t(
          props.defined
            ? 'settings.aiLocal.storage.secretSet'
            : 'settings.aiLocal.storage.secretMissing'
        )}
        onChange={setValue}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={value === ''}
          onClick={() => {
            props.onSave(value)
            setValue('')
          }}
        >
          {t('settings.aiLocal.storage.secretSave')}
        </Button>
        {props.defined && (
          <Button size="sm" variant="danger" onClick={props.onClear}>
            {t('settings.aiLocal.storage.secretClear')}
          </Button>
        )}
      </div>
      {!props.available && (
        <p className="text-xs text-muted">{t('settings.aiLocal.storage.secretUnavailable')}</p>
      )}
    </div>
  )
}

interface StorageFieldsProps {
  storage: AiStorage
  onSave: (patch: Partial<AiStorage>) => void
  secrets: AiSecretsStatus | null
  onSaveSecret: (value: string) => void
  onClearSecret: () => void
}

/** PostgreSQL já existente (modo externo). */
function ExternalFields({
  storage,
  onSave,
  secrets,
  onSaveSecret,
  onClearSecret
}: StorageFieldsProps) {
  const { t } = useTranslation()
  return (
    <>
      <TextRow
        label={t('settings.aiLocal.storage.host')}
        value={storage.postgres.host}
        onSave={(host) => {
          onSave({ postgres: { ...storage.postgres, host } })
        }}
      />
      <NumberRow
        label={t('settings.aiLocal.storage.port')}
        value={storage.postgres.port}
        min={1}
        onSave={(port) => {
          onSave({ postgres: { ...storage.postgres, port } })
        }}
      />
      <TextRow
        label={t('settings.aiLocal.storage.database')}
        value={storage.postgres.database}
        onSave={(database) => {
          onSave({ postgres: { ...storage.postgres, database } })
        }}
      />
      <TextRow
        label={t('settings.aiLocal.storage.username')}
        value={storage.postgres.username}
        onSave={(username) => {
          onSave({ postgres: { ...storage.postgres, username } })
        }}
      />
      <TextRow
        label={t('settings.aiLocal.storage.sslMode')}
        value={storage.postgres.sslMode}
        onSave={(sslMode) => {
          onSave({ postgres: { ...storage.postgres, sslMode } })
        }}
      />
      <NumberRow
        label={t('settings.aiLocal.storage.connectTimeout')}
        value={storage.postgres.connectTimeout}
        min={1}
        onSave={(connectTimeout) => {
          onSave({ postgres: { ...storage.postgres, connectTimeout } })
        }}
      />
      <SecretField
        label={t('settings.aiLocal.storage.postgresPassword')}
        defined={secrets?.postgres === true}
        available={secrets?.available !== false}
        onSave={onSaveSecret}
        onClear={onClearSecret}
      />
    </>
  )
}

/** Container do app (modos local e automático). */
function ContainerFields({
  storage,
  onSave,
  secrets,
  onSaveSecret,
  onClearSecret
}: StorageFieldsProps) {
  const { t } = useTranslation()
  return (
    <>
      <TextRow
        label={t('settings.aiLocal.storage.volume')}
        value={storage.volume}
        optional
        hint={t('settings.aiLocal.storage.volumeHint')}
        onSave={(volume) => {
          onSave({ volume })
        }}
      />
      <TextRow
        label={t('settings.aiLocal.storage.image')}
        value={storage.image}
        onSave={(image) => {
          onSave({ image })
        }}
      />
      <SecretField
        label={t('settings.aiLocal.storage.containerPassword')}
        defined={secrets?.container === true}
        available={secrets?.available !== false}
        onSave={onSaveSecret}
        onClear={onClearSecret}
      />
      {secrets?.container !== true && (
        <p className="text-xs text-muted">{t('settings.aiLocal.storage.secretAuto')}</p>
      )}
    </>
  )
}

function StorageCard({
  storage,
  onSave
}: {
  storage: AiStorage
  onSave: (patch: Partial<AiStorage>) => void
}) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const [secrets, setSecrets] = useState<AiSecretsStatus | null>(null)
  const reload = useCallback(() => {
    void api.ai.secretsStatus().then(setSecrets, () => undefined)
  }, [api])
  useEffect(reload, [reload])

  const saveSecret = async (kind: AiSecretKind, value: string): Promise<void> => {
    await guard(() => api.ai.setSecret(kind, value))
    reload()
  }
  const clearSecret = async (kind: AiSecretKind): Promise<void> => {
    await guard(() => api.ai.clearSecret(kind))
    reload()
  }

  const modes = STORAGE_MODES.map<Option<StorageMode>>((mode) => ({
    value: mode,
    label: t(`settings.aiLocal.storage.modes.${mode}`)
  }))

  return (
    <SettingsCard title={t('settings.aiLocal.storage.title')}>
      <SelectField
        label={t('settings.aiLocal.storage.mode')}
        value={storage.mode}
        options={modes}
        hint={t('settings.aiLocal.storage.modeHint')}
        onChange={(mode) => {
          onSave({ mode })
        }}
      />

      {storage.mode === 'external' && (
        <ExternalFields
          storage={storage}
          onSave={onSave}
          secrets={secrets}
          onSaveSecret={(value) => void saveSecret('postgres', value)}
          onClearSecret={() => void clearSecret('postgres')}
        />
      )}

      {storage.mode === 'auto' && (
        <p className="text-xs text-muted">{t('settings.aiLocal.storage.autoHint')}</p>
      )}

      {(storage.mode === 'local' || storage.mode === 'auto') && (
        <ContainerFields
          storage={storage}
          onSave={onSave}
          secrets={secrets}
          onSaveSecret={(value) => void saveSecret('container', value)}
          onClearSecret={() => void clearSecret('container')}
        />
      )}
    </SettingsCard>
  )
}

/** Diagnóstico sob demanda da pilha de IA (Ollama, LLM, embeddings, RAG e banco). */
function DiagnosticsCard() {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const [checks, setChecks] = useState<AiDiagnosticCheck[] | null>(null)

  const run = async (): Promise<void> => {
    await guard(async () => {
      setChecks(await api.ai.diagnose())
    })
  }

  return (
    <SettingsCard title={t('settings.aiLocal.diagnostics.title')}>
      <p className="text-sm text-muted">{t('settings.aiLocal.diagnostics.intro')}</p>
      <Button size="sm" variant="secondary" className="self-start" onClick={() => void run()}>
        {t('settings.aiLocal.diagnostics.run')}
      </Button>
      {checks !== null && (
        <ul aria-label={t('settings.aiLocal.diagnostics.title')} className="flex flex-col gap-1">
          {checks.map((check) => (
            <li key={check.name} className="flex items-baseline gap-2 text-sm">
              <span aria-hidden>{check.ok ? '✓' : '✗'}</span>
              <span className="font-medium">
                {t(`settings.aiLocal.diagnostics.names.${check.name}`, {
                  defaultValue: check.name
                })}
              </span>
              {check.detail !== null && <span className="text-muted">{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}

/** Passo a passo para instalar e configurar o Ollama (plano §20). */
function OllamaHelpCard({
  llmModel,
  embeddingModel
}: {
  llmModel: string
  embeddingModel: string
}) {
  const { t } = useTranslation()
  const api = useApi()
  const { copied, copy } = useCopy()
  const commands = `ollama pull ${llmModel}\nollama pull ${embeddingModel}`

  return (
    <SettingsCard title={t('settings.aiLocal.help.title')}>
      <p className="text-sm text-muted">{t('settings.aiLocal.help.intro')}</p>
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li className="flex flex-col gap-2">
          <span>{t('settings.aiLocal.help.step1')}</span>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onClick={() => void api.system.openExternal('https://ollama.com/download')}
          >
            {t('settings.aiLocal.help.download')}
          </Button>
        </li>
        <li className="flex flex-col gap-2">
          <span>{t('settings.aiLocal.help.step2')}</span>
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
            ollama serve
          </pre>
        </li>
        <li className="flex flex-col gap-2">
          <span>{t('settings.aiLocal.help.step3')}</span>
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
            {commands}
          </pre>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            onClick={() => void copy(commands)}
          >
            {copied ? t('settings.aiLocal.help.copied') : t('settings.aiLocal.help.copy')}
          </Button>
        </li>
        <li>{t('settings.aiLocal.help.step4')}</li>
      </ol>
      <p className="text-xs text-muted">{t('settings.aiLocal.help.tip')}</p>
    </SettingsCard>
  )
}

/** Reindexação do conhecimento do workspace (plano §26). */
function ReindexRow({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const [reindexed, setReindexed] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<AiReindexProgress | null>(null)

  useEffect(() => api.ai.onReindexProgress(setProgress), [api])

  const start = async (): Promise<void> => {
    setRunning(true)
    setProgress(null)
    await guard(async () => {
      setReindexed(await api.ai.reindex())
    })
    setRunning(false)
  }

  const percent =
    progress === null || progress.total === 0
      ? 0
      : Math.round((progress.completed / progress.total) * 100)

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!enabled || running}
          onClick={() => void start()}
        >
          {t('settings.aiLocal.knowledge.run')}
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={() => void api.ai.cancelReindex()}>
            {t('settings.aiLocal.knowledge.cancel')}
          </Button>
        )}
      </div>
      {running && progress !== null && (
        <p role="status" className="text-sm">
          {t('settings.aiLocal.knowledge.running', {
            percent,
            completed: progress.completed,
            total: progress.total
          })}
        </p>
      )}
      {!running && reindexed !== null && (
        <p className="text-sm">{t('settings.aiLocal.knowledge.done', { count: reindexed })}</p>
      )}
    </>
  )
}

/** Backup, restauração e reindexação do conhecimento do workspace (planos §26–§27). */
function KnowledgeCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const [backedUp, setBackedUp] = useState<AiKnowledgeBackup | null>(null)
  const [restored, setRestored] = useState<AiKnowledgeBackup | null>(null)
  const [reindexRequired, setReindexRequired] = useState(false)

  useEffect(() => {
    if (!enabled) return
    void api.ai.status().then(
      (status) => {
        setReindexRequired(status.reindexRequired)
      },
      () => undefined
    )
    return api.ai.onEvent((event) => {
      if (event.type === 'status') setReindexRequired(event.status.reindexRequired)
    })
  }, [api, enabled])

  const run = async (action: () => Promise<void>): Promise<void> => {
    await guard(action)
  }

  return (
    <SettingsCard title={t('settings.aiLocal.knowledge.title')}>
      <p className="text-sm text-muted">{t('settings.aiLocal.knowledge.intro')}</p>
      {reindexRequired && (
        <p role="status" className="text-sm text-danger">
          {t('settings.aiLocal.knowledge.reindexRequired')}
        </p>
      )}
      <ReindexRow enabled={enabled} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void run(async () => {
              setBackedUp(await api.ai.backup())
            })
          }
        >
          {t('settings.aiLocal.knowledge.backup')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void run(async () => {
              setRestored(await api.ai.restore())
            })
          }
        >
          {t('settings.aiLocal.knowledge.restore')}
        </Button>
      </div>
      {!enabled && <p className="text-xs text-muted">{t('settings.aiLocal.knowledge.disabled')}</p>}
      {backedUp !== null && (
        <p className="text-sm">
          {t('settings.aiLocal.knowledge.backupDone', {
            documents: backedUp.documents,
            analyses: backedUp.analyses
          })}
        </p>
      )}
      {restored !== null && (
        <p className="text-sm">
          {t('settings.aiLocal.knowledge.restoreDone', {
            documents: restored.documents,
            analyses: restored.analyses
          })}
        </p>
      )}
    </SettingsCard>
  )
}

/** Seção "IA local" das configurações: Ollama (análise, RAG e perguntas). */
export function AiLocalSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation()
  const save = useSaveSettings()
  const ai = settings.ai
  const remote = remoteHost(ai.ollamaUrl)
  const set = (patch: Partial<AiSettings>): void => {
    void save(withAi(ai, patch))
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t('settings.aiLocal.intro')}</p>

      <SettingsCard title={t('settings.aiLocal.local.title')}>
        <Toggle
          label={t('settings.aiLocal.local.enabled')}
          description={t('settings.aiLocal.local.enabledHint')}
          checked={ai.enabled}
          onChange={(enabled) => {
            set({ enabled })
          }}
        />
        <Toggle
          label={t('settings.aiLocal.local.incremental')}
          checked={ai.incrementalAnalysisEnabled}
          disabled={!ai.enabled}
          onChange={(incrementalAnalysisEnabled) => {
            set({ incrementalAnalysisEnabled })
          }}
        />
        <Toggle
          label={t('settings.aiLocal.local.final')}
          checked={ai.finalAnalysisEnabled}
          disabled={!ai.enabled}
          onChange={(finalAnalysisEnabled) => {
            set({ finalAnalysisEnabled })
          }}
        />
      </SettingsCard>

      <SettingsCard title={t('settings.aiLocal.connection.title')}>
        <TextRow
          label={t('settings.aiLocal.connection.ollamaUrl')}
          value={ai.ollamaUrl}
          hint={t('settings.aiLocal.connection.ollamaUrlHint')}
          onSave={(ollamaUrl) => {
            set({ ollamaUrl })
          }}
        />
        {remote !== null && (
          <p role="status" className="text-sm text-danger">
            {t('settings.aiLocal.connection.remoteWarning', { host: remote })}
          </p>
        )}
        <Toggle
          label={t('settings.aiLocal.connection.allowRemote')}
          description={t('settings.aiLocal.connection.allowRemoteHint')}
          checked={ai.allowRemoteOllama}
          onChange={(allowRemoteOllama) => {
            set({ allowRemoteOllama })
          }}
        />
        <ModelRow
          label={t('settings.aiLocal.connection.llmModel')}
          value={ai.llmModel}
          onSave={(llmModel) => {
            set({ llmModel })
          }}
        />
        <ModelRow
          label={t('settings.aiLocal.connection.embeddingModel')}
          value={ai.embeddingModel}
          onSave={(embeddingModel) => {
            set({ embeddingModel })
          }}
        />
        <TextRow
          label={t('settings.aiLocal.connection.workspaceId')}
          value={ai.workspaceId}
          hint={t('settings.aiLocal.connection.workspaceIdHint')}
          onSave={(workspaceId) => {
            set({ workspaceId })
          }}
        />
      </SettingsCard>

      <OllamaHelpCard llmModel={ai.llmModel} embeddingModel={ai.embeddingModel} />

      <StorageCard
        storage={ai.storage}
        onSave={(patch) => {
          set({ storage: { ...ai.storage, ...patch } })
        }}
      />

      <DiagnosticsCard />

      <KnowledgeCard enabled={ai.enabled} />

      <SettingsCard title={t('settings.aiLocal.analysis.title')}>
        <NumberRow
          label={t('settings.aiLocal.analysis.window')}
          value={ai.analysisWindowSeconds}
          min={1}
          check={(value) =>
            value > ai.analysisOverlapSeconds ? null : t('settings.aiLocal.validation.window')
          }
          onSave={(analysisWindowSeconds) => {
            set({ analysisWindowSeconds })
          }}
        />
        <NumberRow
          label={t('settings.aiLocal.analysis.overlap')}
          value={ai.analysisOverlapSeconds}
          min={0}
          hint={t('settings.aiLocal.analysis.overlapHint')}
          check={(value) =>
            value < ai.analysisWindowSeconds ? null : t('settings.aiLocal.validation.overlap')
          }
          onSave={(analysisOverlapSeconds) => {
            set({ analysisOverlapSeconds })
          }}
        />
        <NumberRow
          label={t('settings.aiLocal.analysis.concurrency')}
          value={ai.maxConcurrentAnalysis}
          min={1}
          step={1}
          onSave={(maxConcurrentAnalysis) => {
            set({ maxConcurrentAnalysis })
          }}
        />
        <NumberRow
          label={t('settings.aiLocal.analysis.timeout')}
          value={ai.requestTimeoutSeconds}
          min={1}
          onSave={(requestTimeoutSeconds) => {
            set({ requestTimeoutSeconds })
          }}
        />
      </SettingsCard>
    </div>
  )
}
