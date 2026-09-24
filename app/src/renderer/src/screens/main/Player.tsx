import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import type { HistoryMeta } from '../../../../shared/history'
import type { Track } from '../../../../shared/settings'
import type { HistoryDetail } from '../../../../shared/ipc'
import { MODEL_CATALOG } from '../../../../shared/models'
import { Segmented } from '../../components/Segmented'
import { usePlayer } from '../../hooks/usePlayer'
import { useSpeakerLabels } from '../../hooks/useSpeakerLabels'
import { useAppStore } from '../../providers'

function languageName(code: string | null, locale: string): string | null {
  if (code === null) return null
  return new Intl.DisplayNames(locale, { type: 'language', fallback: 'none' }).of(code) ?? code
}

export function describeMeta(meta: HistoryMeta, t: TFunction, locale: string): string {
  const language = languageName(meta.languageDetected ?? meta.language, locale)
  return [
    ...(meta.duration === null ? [] : [formatTime(meta.duration)]),
    MODEL_CATALOG[meta.model].label,
    language ?? t('main.languageAuto')
  ].join(' · ')
}

function Media(props: { video: boolean; src: string; label: string; onError: () => void }) {
  const player = usePlayer()
  const common = {
    ref: player.attach,
    src: props.src,
    controls: true,
    'aria-label': props.label,
    onError: props.onError
  }
  return props.video ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- a transcrição ao lado é a legenda
    <video {...common} className="min-h-0 w-full flex-1 rounded-xl bg-black object-contain" />
  ) : (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- a transcrição ao lado é a legenda
    <audio {...common} className="w-full" />
  )
}

/** Enquanto transcreve, a posição do vídeo pausado acompanha o ponto da transcrição (sem som). */
function useFollowTranscription(meta: HistoryMeta): void {
  const { follow } = usePlayer()
  const processing = meta.status === 'processing'
  // Só na transcrição: na extração o tempo é do áudio sendo convertido, não do que já foi dito.
  const transcribing = useAppStore((s) => s.live[meta.id]?.phase === 'transcribing')
  const processedS = useAppStore((s) => s.live[meta.id]?.progress?.processedS ?? null)
  useEffect(() => {
    if (processing && transcribing && processedS !== null) follow(processedS)
  }, [processing, transcribing, processedS, follow])
}

type Source = 'audio' | Track

/** Ao vivo com as duas faixas: ouvir a mistura ou só um lado da conversa. */
function TrackChoice(props: { tracks: Track[]; value: Source; onChange: (s: Source) => void }) {
  const { t } = useTranslation()
  const labels = useSpeakerLabels()
  if (props.tracks.length < 2) return null
  return (
    <Segmented<Source>
      label={t('result.listen')}
      value={props.value}
      options={[
        { value: 'audio', label: t('result.all') },
        ...props.tracks.map((track) => ({ value: track, label: labels[track] }))
      ]}
      onChange={props.onChange}
    />
  )
}

/** Vídeo original quando existe e toca; senão o áudio salvo no histórico. */
export function Player({ meta, detail }: { meta: HistoryMeta; detail: HistoryDetail | null }) {
  const { t, i18n } = useTranslation()
  const [videoFailed, setVideoFailed] = useState(false)
  const [audioFailed, setAudioFailed] = useState(false)
  const [source, setSource] = useState<Source>('audio')
  const wantsVideo = meta.mediaKind === 'video'
  const showVideo = wantsVideo && detail?.videoAvailable !== false && !videoFailed
  useFollowTranscription(meta)

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <header>
        <h2 className="truncate text-lg font-semibold">{meta.fileName}</h2>
        <p className="text-sm text-muted">{describeMeta(meta, t, i18n.language)}</p>
      </header>
      <TrackChoice tracks={meta.tracks ?? []} value={source} onChange={setSource} />
      <Media
        video={showVideo}
        // A URL muda com o status: o Chromium não reaproveita a falha de antes da extração.
        src={`app-media://${meta.id}/${showVideo ? 'video' : source}?v=${meta.status}`}
        label={t('main.player.label', { name: meta.fileName })}
        onError={() => {
          if (showVideo) setVideoFailed(true)
          else setAudioFailed(true)
        }}
      />
      {wantsVideo && !showVideo && (
        <p className="text-sm text-muted">{t('main.player.videoMissing')}</p>
      )}
      {audioFailed && <p className="text-sm text-muted">{t('main.player.unavailable')}</p>}
    </section>
  )
}
