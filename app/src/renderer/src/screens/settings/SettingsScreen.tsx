import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '../../../../shared/settings'
import { Button } from '../../components/Button'
import { useAppStore } from '../../providers'
import type { SettingsSection } from '../../store/app-store'
import { AboutSection } from './AboutSection'
import { AiSection } from './AiSection'
import { GeneralSection } from './GeneralSection'
import { HelpSection } from './HelpSection'
import { LicensesSection } from './LicensesSection'
import { LiveSection } from './LiveSection'
import { StorageSection } from './StorageSection'
import { TranscriptionSection } from './TranscriptionSection'

const SECTIONS: readonly SettingsSection[] = [
  'general',
  'transcription',
  'live',
  'ai',
  'storage',
  'help',
  'about',
  'licenses'
]

const SECTIONS_CONTENT: Record<SettingsSection, (settings: Settings) => ReactNode> = {
  general: (settings) => <GeneralSection settings={settings} />,
  transcription: (settings) => <TranscriptionSection settings={settings} />,
  live: () => <LiveSection />,
  ai: () => <AiSection />,
  storage: () => <StorageSection />,
  help: () => <HelpSection />,
  about: () => <AboutSection />,
  licenses: () => <LicensesSection />
}

function Content({ section }: { section: SettingsSection }) {
  const settings = useAppStore((s) => s.settings)
  return settings ? SECTIONS_CONTENT[section](settings) : null
}

export function SettingsScreen() {
  const { t } = useTranslation()
  const section = useAppStore((s) => s.settingsSection)
  const openSettings = useAppStore((s) => s.openSettings)
  const closeSettings = useAppStore((s) => s.closeSettings)
  return (
    <div className="flex h-full">
      <nav
        aria-label={t('settings.nav')}
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-line bg-surface p-3"
      >
        <Button variant="ghost" className="mb-2 justify-start" onClick={closeSettings}>
          <ArrowLeft aria-hidden size={16} />
          {t('common.back')}
        </Button>
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'page' : undefined}
            onClick={() => {
              openSettings(id)
            }}
            className={`rounded-lg px-3 py-2 text-left text-sm ${section === id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-surface-2'}`}
          >
            {t(`settings.sections.${id}`)}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-auto p-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <h1 className="text-2xl font-semibold">{t(`settings.sections.${section}`)}</h1>
          <Content section={section} />
        </div>
      </main>
    </div>
  )
}
