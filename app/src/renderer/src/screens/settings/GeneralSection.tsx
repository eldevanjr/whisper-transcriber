import { useTranslation } from 'react-i18next'
import { UI_LANGUAGES, type Settings } from '../../../../shared/settings'
import { RadioGroup, SelectField } from '../../components/Fields'
import { Toggle } from '../../components/Toggle'
import { useSaveSettings } from '../../hooks/useSaveSettings'
import { useSaveTray, useTraySettings } from '../../hooks/useSaveTray'
import { LANGUAGE_NAMES } from '../onboarding/Welcome'

type LanguageChoice = 'system' | (typeof UI_LANGUAGES)[number]

export function GeneralSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation()
  const save = useSaveSettings()
  const tray = useTraySettings()
  const saveTray = useSaveTray()
  const themes = ['system', 'light', 'dark'] as const
  return (
    <div className="flex flex-col gap-6">
      <SelectField<LanguageChoice>
        label={t('settings.general.language')}
        value={settings.uiLanguage ?? 'system'}
        options={[
          { value: 'system', label: t('settings.general.languageSystem') },
          ...UI_LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAMES[value] }))
        ]}
        onChange={(value) => void save({ uiLanguage: value === 'system' ? null : value })}
      />
      <RadioGroup
        label={t('settings.general.theme')}
        name="theme"
        value={settings.theme}
        options={themes.map((value) => ({ value, label: t(`settings.general.themes.${value}`) }))}
        onChange={(theme) => void save({ theme })}
      />
      <Toggle
        label={t('settings.general.updates')}
        description={t('settings.general.updatesHint')}
        checked={settings.checkUpdates}
        onChange={(checkUpdates) => void save({ checkUpdates })}
      />
      <Toggle
        label={t('settings.general.closeToTray')}
        description={t('settings.general.closeToTrayHint')}
        checked={tray.closeToTray}
        onChange={(closeToTray) => void saveTray({ closeToTray })}
      />
      <Toggle
        label={t('settings.general.openAtLogin')}
        description={t('settings.general.openAtLoginHint')}
        checked={tray.openAtLogin}
        onChange={(openAtLogin) => void saveTray({ openAtLogin })}
      />
    </div>
  )
}
