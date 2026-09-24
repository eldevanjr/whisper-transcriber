import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WHISPER_LANGUAGES } from '../../../../shared/languages'
import type { CudaStatus, ModelsStatus } from '../../../../shared/ipc'
import { downloadKey, type Accelerator, type SystemInfo } from '../../../../shared/events'
import {
  formatForDevice,
  MODEL_CATALOG,
  MODEL_IDS,
  type ModelFormat,
  type ModelId
} from '../../../../shared/models'
import type { Device, Settings } from '../../../../shared/settings'
import type { TFunction } from 'i18next'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { RadioGroup, SelectField, SettingsCard, type Option } from '../../components/Fields'
import { GpuUnavailable } from '../../components/GpuUnavailable'
import { ProgressBar } from '../../components/Progress'
import { useGuard } from '../../hooks/useGuard'
import { useSaveSettings } from '../../hooks/useSaveSettings'
import { formatBytes } from '../../lib/bytes'
import { apiLabel } from '../../lib/gpu'
import { useApi, useAppStore } from '../../providers'
import { NVIDIA_EULA_URL } from '../onboarding/ModelChoice'

type ProgressTarget = { kind: 'cuda' } | { kind: 'model'; id: ModelId; format: ModelFormat }

function DownloadProgress({ label, target }: { label: string; target: ProgressTarget }) {
  const { t } = useTranslation()
  const api = useApi()
  const download = useAppStore((s) => s.downloads[downloadKey(target)])
  if (download?.status !== 'active') return null
  const pct = download.total > 0 ? (download.received / download.total) * 100 : 0
  return (
    <div className="flex items-center gap-3">
      <ProgressBar label={label} value={pct} />
      <Button size="sm" variant="ghost" onClick={() => void api.downloads.cancel(target)}>
        {t('settings.models.cancel')}
      </Button>
    </div>
  )
}

function ModelRow(props: {
  id: ModelId
  format: ModelFormat
  size: number
  installed: boolean
  inUse: boolean
  onInstall: () => void
  onUse: () => void
  onRemove: () => void
}) {
  const { t, i18n } = useTranslation()
  const label = MODEL_CATALOG[props.id].label
  return (
    <li className="flex flex-col gap-2 border-b border-line py-3 last:border-0">
      <div className="flex items-center gap-3">
        <span className="font-medium">{label}</span>
        <span className="text-sm text-muted">{formatBytes(props.size, i18n.language)}</span>
        <span className="ml-auto flex gap-2">
          {props.inUse && (
            <span className="text-sm font-medium text-accent">{t('settings.models.inUse')}</span>
          )}
          {props.installed && !props.inUse && (
            <>
              <Button size="sm" onClick={props.onUse}>
                {t('settings.models.use')}
              </Button>
              <Button size="sm" variant="danger" onClick={props.onRemove}>
                {t('settings.models.remove')}
              </Button>
            </>
          )}
          {!props.installed && (
            <Button size="sm" variant="secondary" onClick={props.onInstall}>
              {t('settings.models.download')}
            </Button>
          )}
        </span>
      </div>
      <DownloadProgress
        label={t('settings.models.progress', { model: label })}
        target={{ kind: 'model', id: props.id, format: props.format }}
      />
    </li>
  )
}

function ModelList({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const save = useSaveSettings()
  const format = formatForDevice(settings.device)
  const [status, setStatus] = useState<ModelsStatus | null>(null)
  const [toRemove, setToRemove] = useState<ModelId | null>(null)
  const refresh = useCallback(() => void api.models.status(format).then(setStatus), [api, format])
  useEffect(refresh, [refresh])

  if (!status) return null
  const install = async (id: ModelId): Promise<void> => {
    await guard(() => api.models.install(id, format))
    refresh()
  }
  const remove = async (id: ModelId): Promise<void> => {
    await guard(() => api.models.remove(id, format))
    refresh()
  }

  return (
    <SettingsCard title={t('settings.models.title')}>
      <p className="text-xs text-muted">{t('settings.models.hint')}</p>
      <ul aria-label={t('settings.models.title')}>
        {MODEL_IDS.map((id) => (
          <ModelRow
            key={id}
            id={id}
            format={format}
            size={status.sizes[id]}
            installed={status.installed.includes(id)}
            inUse={settings.model === id}
            onInstall={() => void install(id)}
            onUse={() => void save({ model: id })}
            onRemove={() => {
              setToRemove(id)
            }}
          />
        ))}
      </ul>
      {toRemove && (
        <ConfirmDialog
          open
          title={t('settings.models.removeTitle', { model: MODEL_CATALOG[toRemove].label })}
          message={t('settings.models.removeMessage', {
            size: formatBytes(status.sizes[toRemove], i18n.language)
          })}
          confirmLabel={t('settings.models.remove')}
          cancelLabel={t('common.cancel')}
          destructive
          onCancel={() => {
            setToRemove(null)
          }}
          onConfirm={() => {
            void remove(toRemove)
            setToRemove(null)
          }}
        />
      )}
    </SettingsCard>
  )
}

/** Idioma falado no áudio (também na tela do ao vivo). */
export function AudioLanguageField({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation()
  const save = useSaveSettings()
  const options = useMemo(() => {
    const names = new Intl.DisplayNames(i18n.language, { type: 'language', fallback: 'code' })
    const languages: Option<string>[] = WHISPER_LANGUAGES.map((code) => ({
      value: code,
      label: String(names.of(code))
    }))
    languages.sort((a, b) => a.label.localeCompare(b.label, i18n.language))
    return [{ value: 'auto', label: t('settings.audioLanguage.auto') }, ...languages]
  }, [i18n.language, t])
  return (
    <SelectField
      label={t('settings.audioLanguage.title')}
      value={settings.audioLanguage}
      options={options}
      hint={t('settings.audioLanguage.hint')}
      onChange={(audioLanguage) => void save({ audioLanguage })}
    />
  )
}

function AudioLanguage({ settings }: { settings: Settings }) {
  const { t } = useTranslation()
  return (
    <SettingsCard title={t('settings.audioLanguage.title')}>
      <AudioLanguageField settings={settings} />
    </SettingsCard>
  )
}

function CudaActions(props: { settings: Settings; cuda: CudaStatus; onChanged: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const save = useSaveSettings()
  const [terms, setTerms] = useState(false)
  const accepted = props.settings.nvidiaTermsAccepted
  const install = async (): Promise<void> => {
    const ok = await guard(async () => {
      if (!accepted) await api.settings.update({ nvidiaTermsAccepted: true })
      await api.cuda.install()
    })
    if (ok && !props.cuda.installed) await save({ device: 'cuda' })
    props.onChanged()
  }
  const remove = async (): Promise<void> => {
    await guard(() => api.cuda.remove())
    props.onChanged()
  }
  return (
    <div className="flex flex-col gap-3">
      {!accepted && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={terms}
              onChange={(event) => {
                setTerms(event.target.checked)
              }}
            />
            {t('onboarding.model.terms')}
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void api.system.openExternal(NVIDIA_EULA_URL)}
          >
            {t('onboarding.model.termsLink')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!accepted && !terms}
          onClick={() => void install()}
        >
          {props.cuda.installed
            ? t('settings.processing.reinstall')
            : t('settings.processing.install')}
        </Button>
        {props.cuda.installed && (
          <Button size="sm" variant="danger" onClick={() => void remove()}>
            {t('settings.processing.remove')}
          </Button>
        )}
      </div>
      <DownloadProgress label={t('settings.processing.progress')} target={{ kind: 'cuda' }} />
    </div>
  )
}

/** Troca para a GPU do whisper.cpp; baixa antes o modelo GGML atual, se faltar. */
/** Troca o dispositivo só depois de o modelo estar no formato dele (GGML na GPU, ct2 no resto). */
function useSwitchDevice(settings: Settings): (device: Device) => Promise<void> {
  const api = useApi()
  const guard = useGuard()
  const save = useSaveSettings()
  return async (device) => {
    const model = settings.model
    const format = formatForDevice(device)
    if (model !== null && !(await api.models.status(format)).installed.includes(model)) {
      if (!(await guard(() => api.models.install(model, format)))) return
    }
    await save({ device })
  }
}

interface DeviceChoices {
  nvidia: boolean
  cudaInstalled: boolean
  cudaSize: string
  accelerator: Accelerator | null
  ggmlSize: string
}

function deviceOptions(t: TFunction, choices: DeviceChoices): Option<Device>[] {
  const options: Option<Device>[] = [
    { value: 'cpu', label: t('settings.processing.cpu'), hint: t('settings.processing.cpuHint') }
  ]
  if (choices.nvidia) {
    options.push({
      value: 'cuda',
      label: t('settings.processing.gpu'),
      hint: t('settings.processing.gpuHint', { size: choices.cudaSize }),
      disabled: !choices.cudaInstalled
    })
  }
  const { accelerator } = choices
  if (accelerator) {
    options.push({
      value: 'gpu',
      label: t('settings.processing.gpuAccel', { gpu: accelerator.name }),
      hint: t('settings.processing.gpuAccelHint', {
        api: apiLabel(accelerator),
        size: choices.ggmlSize
      })
    })
  }
  return options
}

function useGgmlSizes(): Partial<Record<ModelId, number>> {
  const api = useApi()
  const [sizes, setSizes] = useState<Partial<Record<ModelId, number>>>({})
  useEffect(() => {
    void api.models.status('ggml').then((status) => {
      setSizes(status.sizes)
    })
  }, [api])
  return sizes
}

/** CUDA só faz sentido com placa NVIDIA (ou se já estiver instalado/em uso). */
function hasNvidiaOption(settings: Settings, cuda: CudaStatus, systemInfo: SystemInfo | null) {
  if (!cuda.supported) return false
  return systemInfo?.gpu != null || cuda.installed || settings.device === 'cuda'
}

function NvidiaStatus(props: { settings: Settings; cuda: CudaStatus; onChanged: () => void }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="text-sm text-muted">
        {props.cuda.installed
          ? t('settings.processing.installed')
          : t('settings.processing.notInstalled')}
      </p>
      <CudaActions settings={props.settings} cuda={props.cuda} onChanged={props.onChanged} />
    </>
  )
}

function DeviceChoice(props: {
  settings: Settings
  cuda: CudaStatus
  nvidia: boolean
  accelerator: Accelerator | null
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation()
  const switchDevice = useSwitchDevice(props.settings)
  const onGgml = formatForDevice(props.settings.device) === 'ggml'
  const ggmlSizes = useGgmlSizes()
  const model = props.settings.model ?? 'medium'
  const ggmlSize = ggmlSizes[model]
  const options = deviceOptions(t, {
    nvidia: props.nvidia,
    cudaInstalled: props.cuda.installed,
    cudaSize: formatBytes(props.cuda.sizeBytes, i18n.language),
    accelerator: props.accelerator,
    ggmlSize: ggmlSize === undefined ? '' : formatBytes(ggmlSize, i18n.language)
  })
  return (
    <>
      <RadioGroup
        label={t('settings.processing.title')}
        name="device"
        value={props.settings.device}
        options={options}
        onChange={(device) => void switchDevice(device)}
      />
      {/* O download do formato atual já aparece na lista de modelos; aqui, o do outro formato. */}
      <DownloadProgress
        label={t(
          onGgml ? 'settings.processing.cpuModelProgress' : 'settings.processing.gpuAccelProgress'
        )}
        target={{ kind: 'model', id: model, format: onGgml ? 'ct2' : 'ggml' }}
      />
      {props.nvidia && (
        <NvidiaStatus settings={props.settings} cuda={props.cuda} onChanged={props.onChanged} />
      )}
    </>
  )
}

function Processing({ settings }: { settings: Settings }) {
  const { t } = useTranslation()
  const api = useApi()
  const systemInfo = useAppStore((s) => s.systemInfo)
  const [cuda, setCuda] = useState<CudaStatus | null>(null)
  const refresh = useCallback(() => void api.cuda.status().then(setCuda), [api])
  useEffect(refresh, [refresh])
  if (!cuda) return null
  const accelerator = systemInfo?.accelerator ?? null
  const nvidia = hasNvidiaOption(settings, cuda, systemInfo)
  return (
    <SettingsCard title={t('settings.processing.title')}>
      {nvidia || accelerator ? (
        <DeviceChoice
          settings={settings}
          cuda={cuda}
          nvidia={nvidia}
          accelerator={accelerator}
          onChanged={refresh}
        />
      ) : (
        <GpuUnavailable reason={systemInfo?.platform === 'darwin' ? 'unsupported' : 'noGpu'} />
      )}
    </SettingsCard>
  )
}

export function TranscriptionSection({ settings }: { settings: Settings }) {
  return (
    <div className="flex flex-col gap-6">
      <ModelList settings={settings} />
      <AudioLanguage settings={settings} />
      <Processing settings={settings} />
    </div>
  )
}
