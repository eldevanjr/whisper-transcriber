import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { UI_LANGUAGES } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { useApi } from '../../providers'

export const LANGUAGE_NAMES: Record<(typeof UI_LANGUAGES)[number], string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
  es: 'Español'
}

export function Welcome({ onNext }: { onNext: () => void }) {
  const { t, i18n } = useTranslation()
  const api = useApi()
  const id = useId()
  return (
    <section className="flex flex-col items-center gap-6 text-center">
      <h1 className="text-3xl font-semibold">{t('onboarding.welcome.title')}</h1>
      <p className="max-w-md text-muted">{t('onboarding.welcome.subtitle')}</p>
      <div className="flex flex-col items-start gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {t('onboarding.welcome.language')}
        </label>
        <select
          id={id}
          value={i18n.language}
          onChange={(event) => {
            const uiLanguage = event.target.value as (typeof UI_LANGUAGES)[number]
            void api.settings.update({ uiLanguage })
          }}
          className="h-10 w-64 rounded-lg border border-line bg-surface px-3"
        >
          {UI_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {LANGUAGE_NAMES[language]}
            </option>
          ))}
        </select>
      </div>
      <Button onClick={onNext}>{t('common.continue')}</Button>
    </section>
  )
}
