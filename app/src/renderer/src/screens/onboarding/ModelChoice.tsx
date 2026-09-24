import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SystemInfo } from '../../../../shared/events'
import { MODEL_CATALOG, MODEL_IDS, type ModelId } from '../../../../shared/models'
import type { Device } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { GpuUnavailable } from '../../components/GpuUnavailable'
import { Toggle } from '../../components/Toggle'
import { formatBytes } from '../../lib/bytes'
import { apiLabel } from '../../lib/gpu'
import { useApi, useAppStore } from '../../providers'

export const NVIDIA_EULA_URL = 'https://docs.nvidia.com/cuda/eula/index.html'

export interface SetupChoice {
  model: ModelId
  /** cpu; cuda = GPU NVIDIA (faster-whisper); gpu = outras GPUs via whisper.cpp. */
  device: Device
}

/** A GPU oferecida no onboarding: NVIDIA (CUDA, com termos) ou outra via whisper.cpp. */
type GpuKind = { kind: 'cuda'; name: string } | { kind: 'gpu'; name: string; api: string }

export function gpuKindOf(systemInfo: SystemInfo): GpuKind | null {
  if (systemInfo.cudaSupported && systemInfo.gpu) return { kind: 'cuda', name: systemInfo.gpu.name }
  const accelerator = systemInfo.accelerator
  if (!accelerator) return null
  return {
    kind: 'gpu',
    name: accelerator.name,
    api: apiLabel(accelerator)
  }
}

function Meter({ label, level }: { label: string; level: number }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted">
      <span className="w-20">{label}</span>
      <span className="flex gap-0.5" aria-label={`${label}: ${level}/4`} role="img">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={`h-1.5 w-4 rounded-full ${step <= level ? 'bg-accent' : 'bg-line'}`}
          />
        ))}
      </span>
    </span>
  )
}

function ModelCard(props: {
  id: ModelId
  size: number | undefined
  recommended: boolean
  checked: boolean
  onSelect: () => void
}) {
  const { t, i18n } = useTranslation()
  const info = MODEL_CATALOG[props.id]
  return (
    <label className="flex cursor-pointer flex-col gap-2 rounded-xl border border-line bg-surface p-4 has-checked:border-accent has-checked:ring-2 has-checked:ring-accent/40">
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="model"
          value={props.id}
          checked={props.checked}
          onChange={props.onSelect}
          className="accent-(--accent-solid)"
        />
        <span className="font-semibold">{info.label}</span>
        {props.recommended && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
            {t('onboarding.model.recommended')}
          </span>
        )}
        <span className="ml-auto text-sm text-muted">
          {props.size === undefined ? '' : formatBytes(props.size, i18n.language)}
        </span>
      </span>
      <Meter label={t('onboarding.model.speed')} level={info.speed} />
      <Meter label={t('onboarding.model.accuracy')} level={info.accuracy} />
    </label>
  )
}

function Terms(props: { terms: boolean; onTerms: (value: boolean) => void }) {
  const { t } = useTranslation()
  const api = useApi()
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.terms}
          onChange={(event) => {
            props.onTerms(event.target.checked)
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
  )
}

interface GpuChoiceProps {
  gpu: boolean
  terms: boolean
  cudaSize: number
  onGpu: (value: boolean) => void
  onTerms: (value: boolean) => void
}

/** Opção de GPU (NVIDIA com termos, ou outra via whisper.cpp); sem GPU, explica por quê. */
function GpuChoice(props: GpuChoiceProps) {
  const { t, i18n } = useTranslation()
  const systemInfo = useAppStore((s) => s.systemInfo)
  if (!systemInfo) return null
  const gpu = gpuKindOf(systemInfo)
  if (!gpu) {
    return <GpuUnavailable reason={systemInfo.platform === 'darwin' ? 'unsupported' : 'noGpu'} />
  }
  const cuda = gpu.kind === 'cuda'
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <Toggle
        label={t(cuda ? 'onboarding.model.gpu' : 'onboarding.model.gpuAccel', { gpu: gpu.name })}
        description={
          cuda
            ? t('onboarding.model.gpuHint', { size: formatBytes(props.cudaSize, i18n.language) })
            : t('onboarding.model.gpuAccelHint', { api: gpu.api })
        }
        checked={props.gpu}
        onChange={props.onGpu}
      />
      {cuda && props.gpu && <Terms terms={props.terms} onTerms={props.onTerms} />}
    </div>
  )
}

export function ModelChoice({ onStart }: { onStart: (choice: SetupChoice) => void }) {
  const { t } = useTranslation()
  const api = useApi()
  const systemInfo = useAppStore((s) => s.systemInfo)
  const headingId = useId()
  const recommended = systemInfo?.recommendedModel ?? 'medium'
  const [sizes, setSizes] = useState<Partial<Record<ModelId, number>>>({})
  const [cudaSize, setCudaSize] = useState(0)
  const [selected, setSelected] = useState<ModelId>(recommended)
  const [gpu, setGpu] = useState(false)
  const [terms, setTerms] = useState(false)
  const gpuKind = systemInfo ? gpuKindOf(systemInfo) : null

  useEffect(() => {
    void Promise.all([api.models.status(), api.cuda.status()]).then(([models, cuda]) => {
      setSizes(models.sizes)
      setCudaSize(cuda.sizeBytes)
      setSelected((current) => models.partial[0] ?? models.installed[0] ?? current)
    })
  }, [api])

  return (
    <section className="flex w-full max-w-3xl flex-col gap-6">
      <header className="text-center">
        <h1 id={headingId} className="text-2xl font-semibold">
          {t('onboarding.model.title')}
        </h1>
        <p className="text-muted">{t('onboarding.model.subtitle')}</p>
      </header>
      <div role="radiogroup" aria-labelledby={headingId} className="grid grid-cols-2 gap-3">
        {MODEL_IDS.map((id) => (
          <ModelCard
            key={id}
            id={id}
            size={sizes[id]}
            recommended={id === recommended}
            checked={selected === id}
            onSelect={() => {
              setSelected(id)
            }}
          />
        ))}
      </div>
      <GpuChoice gpu={gpu} terms={terms} cudaSize={cudaSize} onGpu={setGpu} onTerms={setTerms} />
      <div className="flex justify-end">
        <Button
          disabled={gpu && gpuKind?.kind === 'cuda' && !terms}
          onClick={() => {
            onStart({ model: selected, device: gpu && gpuKind ? gpuKind.kind : 'cpu' })
          }}
        >
          {t('onboarding.model.start')}
        </Button>
      </div>
    </section>
  )
}
