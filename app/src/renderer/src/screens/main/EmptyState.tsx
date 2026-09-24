import { Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../../../../shared/media'
import { Button } from '../../components/Button'
import { useQueueActions } from '../../hooks/useQueueActions'

export function EmptyState() {
  const { t } = useTranslation()
  const actions = useQueueActions()
  return (
    <div className="m-4 flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-line p-8 text-center">
      <Upload aria-hidden size={40} className="text-accent" />
      <p className="text-xl font-semibold">{t('main.empty.title')}</p>
      <Button onClick={() => void actions.chooseAndEnqueue()}>{t('main.empty.choose')}</Button>
      <p className="text-xs text-muted">
        {t('main.empty.formats', {
          video: VIDEO_EXTENSIONS.join(', '),
          audio: AUDIO_EXTENSIONS.join(', ')
        })}
      </p>
    </div>
  )
}
