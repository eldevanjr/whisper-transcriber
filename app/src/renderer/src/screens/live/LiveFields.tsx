import { useTranslation } from 'react-i18next'
import { SelectField } from '../../components/Fields'
import { Toggle } from '../../components/Toggle'
import type { SystemAudioSupport } from '../../hooks/useLiveSupport'
import { useLiveSettings, useSaveLive } from '../../hooks/useSaveLive'
import type { InputDevice } from '../../live/devices'

// O Chromium repete o padrão do sistema como dispositivos próprios: a opção "Padrão" já cobre.
const ALIASES = new Set(['default', 'communications'])

/** Microfone da sessão; '' é o padrão do sistema. Salvo como o microfone padrão do ao vivo. */
export function MicSelect({ devices }: { devices: InputDevice[] }) {
  const { t } = useTranslation()
  const { micDeviceId } = useLiveSettings()
  const save = useSaveLive()
  const mics = devices.filter((d) => !d.monitor && !ALIASES.has(d.id))
  return (
    <SelectField
      label={t('live.mic')}
      value={micDeviceId ?? ''}
      options={[
        { value: '', label: t('live.defaultMic') },
        ...mics.map((d, index) => ({
          value: d.id,
          label: d.label || t('live.unnamedMic', { n: index + 1 })
        }))
      ]}
      onChange={(id) => void save({ micDeviceId: id || null })}
    />
  )
}

export function SystemAudioToggle(props: {
  support: SystemAudioSupport | null
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const { systemAudio } = useLiveSettings()
  const save = useSaveLive()
  const unavailable = props.support === 'unavailable'
  return (
    <Toggle
      label={t('live.systemAudio')}
      description={t(unavailable ? 'live.systemUnavailable' : 'live.systemAudioHint')}
      checked={systemAudio && !unavailable}
      disabled={unavailable || props.disabled}
      onChange={(checked) => void save({ systemAudio: checked })}
    />
  )
}
