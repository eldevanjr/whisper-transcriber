import { useTranslation } from 'react-i18next'
import { SettingsCard } from '../../components/Fields'
import { useInputDevices } from '../../hooks/useInputDevices'
import { useLiveSupport } from '../../hooks/useLiveSupport'
import { MicSelect, SystemAudioToggle } from '../live/LiveFields'
import { MonitorVolumeSlider } from '../live/MonitorVolume'
import { PauseSlider } from '../live/PauseSlider'

/** Padrões do ao vivo: a tela de preparar começa com eles. */
export function LiveSection() {
  const { t } = useTranslation()
  const devices = useInputDevices()
  const support = useLiveSupport()
  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title={t('live.sources')}>
        <MicSelect devices={devices} />
        <SystemAudioToggle support={support} />
        {support !== 'unavailable' && <MonitorVolumeSlider />}
      </SettingsCard>
      <SettingsCard title={t('live.transcription')}>
        <PauseSlider />
      </SettingsCard>
    </div>
  )
}
