import { Copy, Download, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  paragraphsToText,
  speakerPrefix,
  toJson,
  toParagraphs,
  toTimestamped,
  type Paragraph,
  type SpeakerLabels
} from '../../../../shared/format'
import type { HistoryMeta, TranscriptEntry } from '../../../../shared/history'
import type { HistoryDetail, TranscriptVersion } from '../../../../shared/ipc'
import { clientDisplayName } from '../../../../shared/mcp'
import { Button } from '../../components/Button'
import { Segmented } from '../../components/Segmented'
import { Tabs } from '../../components/Tabs'
import { errorInfoOf } from '../../errors'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useCopy } from '../../hooks/useCopy'
import { useGuard } from '../../hooks/useGuard'
import { useSpeakerLabels } from '../../hooks/useSpeakerLabels'
import { usePlayer } from '../../hooks/usePlayer'
import { useApi, useAppStore } from '../../providers'
import { SegmentList } from './ChatPanel'
import { JsonView } from './JsonView'

type Tab = 'segments' | 'text' | 'timed' | 'json'

const NO_ENTRIES: TranscriptEntry[] = []

function Paragraphs({ paragraphs, labels }: { paragraphs: Paragraph[]; labels: SpeakerLabels }) {
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
            {speakerPrefix(paragraph.falante, labels)}
            {paragraph.text}
          </button>
        )
      })}
    </div>
  )
}

interface Formatted {
  entries: TranscriptEntry[]
  paragraphs: Paragraph[]
  labels: SpeakerLabels
}

function formatFor(tab: Tab, { entries, paragraphs, labels }: Formatted): string {
  if (tab === 'text') return paragraphsToText(paragraphs, labels)
  // Trechos baixa com os tempos
  return tab === 'json' ? toJson(entries) : toTimestamped(entries, labels)
}

function TabBody(props: { tab: Tab } & Formatted) {
  if (props.tab === 'segments') {
    const segments = props.entries.map((e) => ({
      start: e.inicio,
      end: e.fim,
      text: e.texto,
      speaker: e.falante
    }))
    return (
      <div className="p-4">
        <SegmentList segments={segments} />
      </div>
    )
  }
  if (props.tab === 'text')
    return <Paragraphs paragraphs={props.paragraphs} labels={props.labels} />
  if (props.tab === 'json') return <JsonView json={toJson(props.entries)} />
  return (
    <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {toTimestamped(props.entries, props.labels)}
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

/**
 * Item ao vivo: antes de refazer, o aviso com "Refazer com o áudio completo"; depois, a escolha
 * da versão mostrada (Refeita · Ao vivo).
 */
function LiveVersion({ meta, detail }: { meta: HistoryMeta; detail: HistoryDetail }) {
  const { t } = useTranslation()
  const api = useApi()
  const guard = useGuard()
  const actions = useQueueActions()
  if (!detail.hasRedo) {
    return (
      <div
        role="note"
        className="m-4 mb-0 flex flex-col items-start gap-2 rounded-lg bg-accent-soft p-3 text-sm"
      >
        <p>{t('result.liveNote')}</p>
        <Button size="sm" onClick={() => void actions.retry(meta.id)}>
          <RotateCcw aria-hidden size={14} />
          {t('result.redoLive')}
        </Button>
      </div>
    )
  }
  return (
    <div className="px-4 pt-3">
      <Segmented<TranscriptVersion>
        label={t('result.version')}
        value={meta.activeVersion === 'live' ? 'live' : 'redo'}
        options={[
          { value: 'redo', label: t('result.redone') },
          { value: 'live', label: t('result.liveVersion') }
        ]}
        onChange={(version) => void guard(() => api.history.setVersion(meta.id, version))}
      />
    </div>
  )
}

function RequestedBy({ id }: { id?: string }) {
  const { t } = useTranslation()
  if (id === undefined) return null
  return (
    <span className="text-xs whitespace-nowrap text-muted">
      {t('common.viaClient', { client: clientDisplayName(id) })}
    </span>
  )
}

function Toolbar(props: {
  empty: boolean
  redo: boolean
  copied: boolean
  onCopy: () => void
  onDownload: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex gap-1 py-1">
      <Button size="sm" variant="ghost" disabled={props.empty} onClick={props.onCopy}>
        <Copy aria-hidden size={14} />
        {props.copied ? t('common.copied') : t('common.copy')}
      </Button>
      <Button size="sm" variant="ghost" disabled={props.empty} onClick={props.onDownload}>
        <Download aria-hidden size={14} />
        {t('common.download')}
      </Button>
      {props.redo && (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          <RotateCcw aria-hidden size={14} />
          {t('main.retry')}
        </Button>
      )}
    </div>
  )
}

/** Resultado em abas (Trechos, Texto, Com tempos, JSON), com Copiar e Baixar agindo na aba aberta. */
export function ResultPanel({ meta, detail }: { meta: HistoryMeta; detail: HistoryDetail | null }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('segments')
  const { copied, copy } = useCopy()
  const download = useDownload(meta)
  const labels = useSpeakerLabels()
  const entries = detail?.transcript ?? NO_ENTRIES
  const paragraphs = useMemo(() => toParagraphs(entries), [entries])
  const content = (): string => formatFor(tab, { entries, paragraphs, labels })
  const empty = entries.length === 0
  const actionsQueue = useQueueActions()
  const redo = meta.status === 'done'
  const retry = () => void actionsQueue.retry(meta.id)

  const actions = (
    <div className="flex items-center gap-2">
      <RequestedBy id={meta.requestedBy} />
      <Toolbar
        empty={empty}
        redo={redo}
        onCopy={() => void copy(content())}
        copied={copied}
        onDownload={() => void download(tab, content())}
        onRetry={retry}
      />
    </div>
  )

  return (
    <section aria-label={t('result.title')} className="flex h-full min-h-0 flex-col">
      {meta.kind === 'live' && detail && <LiveVersion meta={meta} detail={detail} />}
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
        {empty ? null : (
          <TabBody tab={tab} entries={entries} paragraphs={paragraphs} labels={labels} />
        )}
      </Tabs>
    </section>
  )
}
