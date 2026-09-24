import { useCallback, useEffect, useRef, useState } from 'react'
import type { ErrorInfo } from '../../../shared/errors'
import type { TranscriberApi } from '../../../shared/ipc'
import { formatForDevice, type ModelFormat } from '../../../shared/models'
import type { Device } from '../../../shared/settings'
import { errorInfoOf } from '../errors'
import { useApi } from '../providers'
import type { SetupChoice } from '../screens/onboarding/ModelChoice'

export type SetupStep = 'model' | 'cuda' | 'test'
export type StepStatus = 'pending' | 'active' | 'done' | 'failed'

const ACTIONS: Record<SetupStep, (api: TranscriberApi, choice: SetupChoice) => Promise<void>> = {
  async model(api, choice) {
    // Grava o dispositivo (uma tentativa anterior pode ter deixado outro); CUDA só depois do download.
    await api.settings.update(
      choice.device === 'cuda' ? { nvidiaTermsAccepted: true } : { device: choice.device }
    )
    await api.models.install(choice.model, formatForDevice(choice.device))
  },
  async cuda(api) {
    await api.cuda.install()
    await api.settings.update({ device: 'cuda' })
  },
  async test(api, choice) {
    // Gravar o modelo antes do teste: o autoteste usa o modelo configurado.
    await api.settings.update({ model: choice.model })
    await api.engine.selfTest()
  }
}

const stepsFor = (device: Device): SetupStep[] =>
  device === 'cuda' ? ['model', 'cuda', 'test'] : ['model', 'test']

export interface Setup {
  steps: SetupStep[]
  status: Record<SetupStep, StepStatus>
  error: ErrorInfo | null
  finished: boolean
  /** Formato do modelo sendo baixado agora (muda para ct2 se a GPU do whisper.cpp falhar). */
  format: ModelFormat
  retry: () => void
  /** GPU falhou no teste: segue na CPU (baixando o modelo da CPU se a GPU era do whisper.cpp). */
  useCpu: () => void
}

/** Executa as etapas do onboarding em ordem; "Tentar de novo" retoma da que falhou. */
export function useSetup(choice: SetupChoice): Setup {
  const api = useApi()
  const steps = stepsFor(choice.device)
  const [format, setFormat] = useState<ModelFormat>(formatForDevice(choice.device))
  const [status, setStatus] = useState<Record<SetupStep, StepStatus>>({
    model: 'pending',
    cuda: 'pending',
    test: 'pending'
  })
  const [error, setError] = useState<ErrorInfo | null>(null)
  const started = useRef(false)
  const completed = useRef(new Set<SetupStep>())

  const run = useCallback(async () => {
    setError(null)
    for (const step of stepsFor(choice.device)) {
      if (completed.current.has(step)) continue
      setStatus((current) => ({ ...current, [step]: 'active' }))
      try {
        await ACTIONS[step](api, choice)
      } catch (failure) {
        setStatus((current) => ({ ...current, [step]: 'failed' }))
        setError(errorInfoOf(failure))
        return
      }
      completed.current.add(step)
      setStatus((current) => ({ ...current, [step]: 'done' }))
    }
  }, [api, choice])

  useEffect(() => {
    if (started.current) return // StrictMode monta duas vezes: o download só pode começar uma
    started.current = true
    void run()
  }, [run])

  const useCpu = async (): Promise<void> => {
    setError(null)
    setStatus((current) => ({ ...current, test: 'active' }))
    try {
      await api.settings.update({ device: 'cpu' })
      if (choice.device === 'gpu') {
        setFormat('ct2')
        await api.models.install(choice.model, 'ct2')
      }
    } catch (failure) {
      setStatus((current) => ({ ...current, test: 'failed' }))
      setError(errorInfoOf(failure))
      return
    }
    await run()
  }

  return {
    steps,
    status,
    error,
    finished: steps.every((step) => status[step] === 'done'),
    format,
    retry: () => void run(),
    useCpu: () => void useCpu()
  }
}
