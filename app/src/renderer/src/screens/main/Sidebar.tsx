import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  FileQuestion,
  FolderSearch,
  LoaderCircle,
  Pause,
  Plus,
  RotateCcw,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { HistoryMeta, JobStatus } from '../../../../shared/history'
import { Button, IconButton } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useAppStore } from '../../providers'

const STATUS_ICON: Record<JobStatus, LucideIcon> = {
  queued: Clock,
  processing: LoaderCircle,
  done: CircleCheck,
  failed: CircleAlert,
  canceled: CircleSlash,
  interrupted: Pause
}

const RETRYABLE = new Set<JobStatus>(['failed', 'canceled', 'interrupted'])

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-h-0 flex-col gap-1">
      <h2 id={id} className="px-2 text-xs font-semibold tracking-wide text-muted uppercase">
        {title}
      </h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  )
}

function Row(props: {
  label: string
  sublabel: string
  icon: LucideIcon
  spinning?: boolean
  selected?: boolean
  onSelect?: () => void
  actions?: ReactNode
}) {
  const Icon = props.icon
  const content = (
    <>
      <Icon
        aria-hidden
        size={16}
        className={`shrink-0 ${props.spinning ? 'animate-spin text-accent' : 'text-muted'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{props.label}</span>
        <span className="block text-xs text-muted">{props.sublabel}</span>
      </span>
    </>
  )
  return (
    <li
      className={`group flex items-center gap-1 rounded-lg border-l-2 pr-1 ${props.selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-surface-2'}`}
    >
      {props.onSelect ? (
        <button
          type="button"
          aria-current={props.selected ? 'true' : undefined}
          onClick={props.onSelect}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">{content}</div>
      )}
      {props.actions}
    </li>
  )
}

function EntryActions({ meta, onDelete }: { meta: HistoryMeta; onDelete: () => void }) {
  const { t } = useTranslation()
  const actions = useQueueActions()
  const name = meta.fileName
  return (
    <>
      {meta.error?.code === 'FILE_NOT_FOUND' && (
        <IconButton
          label={`${t('main.locate')}: ${name}`}
          icon={FolderSearch}
          onClick={() => void actions.locate(meta.id)}
        />
      )}
      {RETRYABLE.has(meta.status) && (
        <IconButton
          label={`${t('main.retry')}: ${name}`}
          icon={RotateCcw}
          onClick={() => void actions.retry(meta.id)}
        />
      )}
      <IconButton label={`${t('main.delete')}: ${name}`} icon={Trash2} onClick={onDelete} />
    </>
  )
}

export function Sidebar() {
  const { t } = useTranslation()
  const actions = useQueueActions()
  const queue = useAppStore((s) => s.queue)
  const entries = useAppStore((s) => s.entries)
  const corrupted = useAppStore((s) => s.corrupted)
  const selectedId = useAppStore((s) => s.selectedId)
  const select = useAppStore((s) => s.select)
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null)

  const inQueue = [queue.current, ...queue.pending].flatMap((id) => {
    const meta = id === null ? undefined : entries[id]
    return meta ? [meta] : []
  })
  const history = useMemo(
    () =>
      Object.values(entries)
        .filter((meta) => meta.status !== 'queued' && meta.status !== 'processing')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries]
  )

  return (
    <nav
      aria-label={t('main.sidebar')}
      className="flex h-full flex-col gap-4 overflow-auto border-r border-line bg-surface p-3"
    >
      <Button onClick={() => void actions.chooseAndEnqueue()}>
        <Plus aria-hidden size={16} />
        {t('main.add')}
      </Button>
      {inQueue.length > 0 && (
        <Section title={t('main.queue', { count: inQueue.length })}>
          {inQueue.map((meta) => (
            <Row
              key={meta.id}
              label={meta.fileName}
              sublabel={t(`main.status.${meta.status}`)}
              icon={STATUS_ICON[meta.status]}
              spinning={meta.status === 'processing'}
              selected={selectedId === meta.id}
              onSelect={() => {
                select(meta.id)
              }}
              actions={
                meta.status === 'queued' && (
                  <IconButton
                    label={t('main.removeFromQueue')}
                    icon={X}
                    onClick={() => void actions.removeFromQueue(meta.id)}
                  />
                )
              }
            />
          ))}
        </Section>
      )}
      <Section title={t('main.history')}>
        {history.length === 0 && corrupted.length === 0 && (
          <li className="px-2 text-sm text-muted">{t('main.historyEmpty')}</li>
        )}
        {history.map((meta) => (
          <Row
            key={meta.id}
            label={meta.fileName}
            sublabel={t(`main.status.${meta.status}`)}
            icon={STATUS_ICON[meta.status]}
            selected={selectedId === meta.id}
            onSelect={() => {
              select(meta.id)
            }}
            actions={
              <EntryActions
                meta={meta}
                onDelete={() => {
                  setToDelete({ id: meta.id, name: meta.fileName })
                }}
              />
            }
          />
        ))}
        {corrupted.map((id) => (
          <Row
            key={id}
            label={t('main.corrupted')}
            sublabel={id}
            icon={FileQuestion}
            actions={
              <IconButton
                label={`${t('main.delete')}: ${id}`}
                icon={Trash2}
                onClick={() => {
                  setToDelete({ id, name: id })
                }}
              />
            }
          />
        ))}
      </Section>
      {toDelete && (
        <ConfirmDialog
          open
          title={t('main.deleteTitle')}
          message={t('main.deleteMessage', { name: toDelete.name })}
          confirmLabel={t('main.delete')}
          cancelLabel={t('common.cancel')}
          destructive
          onCancel={() => {
            setToDelete(null)
          }}
          onConfirm={() => {
            void actions.deleteEntry(toDelete.id)
            setToDelete(null)
          }}
        />
      )}
    </nav>
  )
}
