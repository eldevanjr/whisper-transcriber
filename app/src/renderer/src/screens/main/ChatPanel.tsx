import { useEffect, useId, useRef, type UIEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import type { HistoryMeta, Segment } from '../../../../shared/history'
import type { HistoryDetail } from '../../../../shared/ipc'
import { Button } from '../../components/Button'
import { ErrorNotice } from '../../components/ErrorNotice'
import { usePlayer } from '../../hooks/usePlayer'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useSpeakerLabels } from '../../hooks/useSpeakerLabels'
import { useAppStore } from '../../providers'

const STICK_PX = 40
const NO_SEGMENTS: Segment[] = []

function Bubble({
  segment,
  active,
  onSeek
}: {
  segment: Segment
  active: boolean
  onSeek: () => void
}) {
  const labels = useSpeakerLabels()
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSeek}
        className={`w-full rounded-2xl rounded-tl-sm px-3 py-2 text-left text-sm ${active ? 'bg-accent-soft ring-1 ring-accent' : 'bg-surface-2 hover:bg-accent-soft'}`}
      >
        {segment.speaker && (
          <span className="mr-2 text-xs font-medium text-muted">{labels[segment.speaker]}</span>
        )}
        <span className="mr-2 font-mono text-xs text-accent">{formatTime(segment.start)}</span>{' '}
        {segment.text.trim()}
      </button>
    </li>
  )
}

/** Balões com o tempo de cada trecho: clicar pula o player; o que toca fica destacado. */
export function SegmentList({ segments }: { segments: Segment[] }) {
  const player = usePlayer()
  return (
    <ol className="flex flex-col gap-2">
      {segments.map((segment, index) => (
        <Bubble
          key={`${segment.start}-${index}`}
          segment={segment}
          active={player.currentTime >= segment.start && player.currentTime < segment.end}
          onSeek={() => {
            player.seek(segment.start)
          }}
        />
      ))}
    </ol>
  )
}

function FailureActions({ meta }: { meta: HistoryMeta }) {
  const { t } = useTranslation()
  const actions = useQueueActions()
  return (
    <>
      {meta.error?.code === 'FILE_NOT_FOUND' && (
        <Button size="sm" onClick={() => void actions.locate(meta.id)}>
          {t('main.locate')}
        </Button>
      )}
      <Button size="sm" onClick={() => void actions.retry(meta.id)}>
        {t('main.retry')}
      </Button>
    </>
  )
}

/** Trechos como balões de chat: ao vivo durante a transcrição, do parcial/transcrição depois. */
export function ChatPanel({ meta, detail }: { meta: HistoryMeta; detail: HistoryDetail | null }) {
  const { t } = useTranslation()
  const titleId = useId()
  const processing = meta.status === 'processing'
  const live = useAppStore((s) => s.live[meta.id]?.segments ?? NO_SEGMENTS)
  const saved = detail?.transcript.map((e) => ({ start: e.inicio, end: e.fim, text: e.texto }))
  const segments = processing ? live : (saved ?? NO_SEGMENTS)
  const list = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)

  useEffect(() => {
    const element = list.current
    if (element && stuck.current) element.scrollTop = element.scrollHeight
  }, [segments.length])

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    const element = event.currentTarget
    stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
  }

  return (
    <section aria-labelledby={titleId} className="flex h-full min-h-0 flex-col gap-3 p-4">
      <h2 id={titleId} className="text-sm font-semibold tracking-wide text-muted uppercase">
        {t('main.chat.title')}
      </h2>
      {meta.status === 'failed' && meta.error && (
        <ErrorNotice error={meta.error} actions={<FailureActions meta={meta} />} />
      )}
      {segments.length === 0 && <p className="text-sm text-muted">{t('main.chat.empty')}</p>}
      <div
        ref={list}
        role="log"
        aria-labelledby={titleId}
        aria-live="polite"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        <SegmentList segments={segments} />
      </div>
      {processing && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <span className="flex gap-1" aria-hidden>
            <span className="size-1.5 animate-bounce rounded-full bg-accent" />
            <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-accent [animation-delay:300ms]" />
          </span>
          {t('main.chat.typing')}
        </p>
      )}
    </section>
  )
}
