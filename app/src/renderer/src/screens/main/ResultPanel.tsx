import { Copy, Download, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  paragraphsToText,
  toJson,
  toParagraphs,
  toTimestamped,
  type Paragraph
} from '../../../../shared/format'
import type { HistoryMeta, TranscriptEntry } from '../../../../shared/history'
import type { HistoryDetail } from '../../../../shared/ipc'
import { Button } from '../../components/Button'
import { Tabs } from '../../components/Tabs'
import { errorInfoOf } from '../../errors'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useCopy } from '../../hooks/useCopy'
import { usePlayer } from '../../hooks/usePlayer'
import { useApi, useAppStore } from '../../providers'
import { SegmentList } from './ChatPanel'
import { JsonView } from './JsonView'

type Tab = 'segments' | 'text' | 'timed' | 'json'

const NO_ENTRIES: TranscriptEntry[] = []

function Paragraphs({ paragraphs }: { paragraphs: Paragraph[] }) {
  const player = usePlayer()
  return (
    <div className="flex flex-col gap-3 p-4">
      {paragraphs.map((paragraph) => {
        const active = player.currentTime >= paragraph.start && player.currentTime < paragraph.end
        return (
          <button
            key={paragraph.start}
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              player.seek(paragraph.start)
            }}
            className={`rounded-lg px-3 py-2 text-left leading-relaxed ${active ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface-2'}`}
          >
            {paragraph.text}
          </button>
        )
      })}
    </div>
  )
}

function formatFor(tab: Tab, entries: TranscriptEntry[], paragraphs: Paragraph[]): string {
  if (tab === 'text') return paragraphsToText(paragraphs)
  return tab === 'json' ? toJson(entries) : toTimestamped(entries) // Trechos baixa com os tempos
}

function TabBody(props: { tab: Tab; entries: TranscriptEntry[]; paragraphs: Paragraph[] }) {
  if (props.tab === 'segments') {
    const segments = props.entries.map((e) => ({ start: e.inicio, end: e.fim, text: e.texto }))
    return (
      <div className="p-4">
        <SegmentList segments={segments} />
      </div>
    )
  }
  if (props.tab === 'text') return <Paragraphs paragraphs={props.paragraphs} />
  if (props.tab === 'json') return <JsonView json={toJson(props.entries)} />
  return (
    <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {toTimestamped(props.entries)}
    </pre>
  )
}

function useDownload(meta: HistoryMeta) {
  const api = useApi()
  const pushNotice = useAppStore((s) => s.pushNotice)
  return async (tab: Tab, content: string): Promise<void> => {
    const base = meta.fileName.replace(/\.[^.]+$/, '')
    const extension = tab === 'json' ? 'json' : 'txt'
    try {
      const saved = await api.files.save({
        defaultName: `transcricao-${base}.${extension}`,
        content
      })
      if (saved) pushNotice({ kind: 'info', key: 'result.saved' })
    } catch (error) {
      const info = errorInfoOf(error)
      pushNotice({ kind: 'error', key: `errors.${info.code}`, error: info })
    }
  }
}

/** Resultado em abas (Trechos, Texto, Com tempos, JSON), com Copiar e Baixar agindo na aba aberta. */
export function ResultPanel({ meta, detail }: { meta: HistoryMeta; detail: HistoryDetail | null }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('segments')
  const { copied, copy } = useCopy()
  const download = useDownload(meta)
  const entries = detail?.transcript ?? NO_ENTRIES
  const paragraphs = useMemo(() => toParagraphs(entries), [entries])
  const content = (): string => formatFor(tab, entries, paragraphs)
  const empty = entries.length === 0
  const actionsQueue = useQueueActions()
  const redo = meta.status === 'done'
  const retry = () => void actionsQueue.retry(meta.id)

  const actions = (
    <div className="flex gap-1 py-1">
      <Button size="sm" variant="ghost" disabled={empty} onClick={() => void copy(content())}>
        <Copy aria-hidden size={14} />
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={empty}
        onClick={() => void download(tab, content())}
      >
        <Download aria-hidden size={14} />
        {t('common.download')}
      </Button>
      {redo && (
        <Button size="sm" variant="ghost" onClick={retry}>
          <RotateCcw aria-hidden size={14} />
          {t('main.retry')}
        </Button>
      )}
    </div>
  )

  return (
    <section aria-label={t('result.title')} className="flex h-full min-h-0 flex-col">
      <Tabs
        label={t('result.tabs')}
        tabs={[
          { id: 'segments', label: t('result.segments') },
          { id: 'text', label: t('result.text') },
          { id: 'timed', label: t('result.timed') },
          { id: 'json', label: t('result.json') }
        ]}
        value={tab}
        onChange={(id) => {
          setTab(id as Tab)
        }}
        actions={actions}
      >
        {empty && detail !== null && (
          <div className="flex flex-col items-start gap-3 p-4 text-sm text-muted">
            <p>{t('result.empty')}</p>
            {redo && (
              <>
                <p>{t('result.emptyHint')}</p>
                <Button size="sm" onClick={retry}>
                  {t('main.retry')}
                </Button>
              </>
            )}
          </div>
        )}
        {empty ? null : <TabBody tab={tab} entries={entries} paragraphs={paragraphs} />}
      </Tabs>
    </section>
  )
}
