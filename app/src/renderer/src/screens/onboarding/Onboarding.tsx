import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Logo } from '../../components/Logo'
import { useAppStore } from '../../providers'
import { DownloadStep } from './DownloadStep'
import { ModelChoice, type SetupChoice } from './ModelChoice'
import { Welcome } from './Welcome'

export function Onboarding() {
  const { t } = useTranslation()
  const finishOnboarding = useAppStore((s) => s.finishOnboarding)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [choice, setChoice] = useState<SetupChoice | null>(null)
  const [attempt, setAttempt] = useState(0)

  return (
    <main className="flex h-full flex-col overflow-auto">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="flex items-center gap-2 font-semibold">
          <Logo />
          {t('app.name')}
        </span>
        <span className="text-sm text-muted">
          {t('onboarding.steps', { current: step, total: 3 })}
        </span>
      </header>
      <div className="flex flex-1 items-start justify-center px-6 py-8">
        {step === 1 && (
          <Welcome
            onNext={() => {
              setStep(2)
            }}
          />
        )}
        {step === 2 && (
          <ModelChoice
            onStart={(next) => {
              setChoice(next)
              setAttempt((count) => count + 1) // cada tentativa começa um download novo
              setStep(3)
            }}
          />
        )}
        {step === 3 && choice && (
          <DownloadStep
            key={attempt}
            choice={choice}
            onDone={finishOnboarding}
            onBack={() => {
              setStep(2)
            }}
          />
        )}
      </div>
    </main>
  )
}
