import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '../../../../shared/format'
import type { JobStatus } from '../../../../shared/history'
import type {
  AiAnalysis,
  AiAnalysisItem,
  AiAnswer,
  AiAnswerSource,
  AiEntityKind,
  AiStatus,
  AiStorageStatus
} from '../../../../shared/ipc'
import { Button } from '../../components/Button'
import { errorInfoOf } from '../../errors'
import { usePlayer } from '../../hooks/usePlayer'
import { useApi } from '../../providers'

const KINDS: readonly AiEntityKind[] = [
  'topic',
  'task',
  'decision',
  'problem',
  'question',
  'person'
]

/** Estados que merecem destaque (DETECTED é o normal). */
const SHOWN_STATES = new Set(['UPDATED', 'CONFIRMED', 'CANCELLED'])

function indexPercent(status: AiStatus): number {
  if (status.index.total === 0) return 100
  return Math.round((status.index.completed / status.index.total) * 100)
}

function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation()
  return (
    <p role="alert" className="text-sm text-danger">
      {t(`errors.${errorInfoOf(error).code}`)}
    </p>
  )
}

function Item({ item }: { item: AiAnalysisItem }) {
  const { t } = useTranslation()
  const player = usePlayer()
  const start = item.start
  const state = item.state !== null && SHOWN_STATES.has(item.state) ? item.state : null
  return (
    <li>
      <button
        type="button"
        disabled={start === null}
        onClick={
          start === null
            ? undefined
            : () => {
                player.seek(start)
              }
        }
        className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:hover:bg-transparent"
      >
        <span className="flex items-baseline gap-2">
          {start !== null && (
            <span className="font-mono text-xs text-accent">{formatTime(start)}</span>
          )}
          <span className={state === 'CANCELLED' ? 'line-through' : undefined}>{item.text}</span>
          {state !== null && (
            <span className="rounded bg-surface-2 px-1.5 text-xs text-muted">
              {t(`main.intelligence.states.${state}`)}
            </span>
          )}
        </span>
        {item.detail !== null && <span className="text-xs text-muted">{item.detail}</span>}
      </button>
    </li>
  )
}

function Section({ kind, items }: { kind: AiEntityKind; items: AiAnalysisItem[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t(`main.intelligence.kinds.${kind}`)}
      </h3>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function FallbackNote({ storage }: { storage: AiStorageStatus }) {
  const { t } = useTranslation()
  return (
    <p className="text-xs text-muted">
      {storage.reason === null
        ? t('main.intelligence.fallback')
        : t('main.intelligence.fallbackReason', { reason: storage.reason })}
    </p>
  )
}

function AiStateLine({ status }: { status: AiStatus }) {
  const { t } = useTranslation()
  return (
    <p role="status" className={status.enabled ? 'text-sm' : 'text-sm text-muted'}>
      {status.enabled
        ? t('main.intelligence.status', {
            pending: status.pendingAnalysis,
            percent: indexPercent(status)
          })
        : t('main.intelligence.off')}
    </p>
  )
}

function Warnings({ status }: { status: AiStatus }) {
  const { t } = useTranslation()
  return (
    <>
      {status.blocked !== null && <p className="text-sm text-danger">{status.blocked}</p>}
      {status.reindexRequired && (
        <p className="text-sm text-danger">{t('main.intelligence.reindexRequired')}</p>
      )}
      {status.storage?.fallback === true && <FallbackNote storage={status.storage} />}
    </>
  )
}

function StatusLines({
  status,
  transcriptionStatus
}: {
  status: AiStatus | null
  transcriptionStatus: JobStatus
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        {t('main.intelligence.transcription', {
          state: t(`main.intelligence.transcriptionStates.${transcriptionStatus}`)
        })}
      </p>
      {status !== null && <AiStateLine status={status} />}
      {status !== null && <Warnings status={status} />}
    </div>
  )
}

function Summary({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
        {t('main.intelligence.summary')}
      </h3>
      <p className="text-sm leading-relaxed">{text}</p>
    </section>
  )
}

function AnalysisView({ analysis, partial }: { analysis: AiAnalysis; partial: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4">
      {partial && <p className="text-xs text-muted">{t('main.intelligence.partial')}</p>}
      {analysis.summary !== null && <Summary text={analysis.summary} />}
      {KINDS.map((kind) => (
        <Section
          key={kind}
          kind={kind}
          items={analysis.items.filter((item) => item.kind === kind)}
        />
      ))}
    </div>
  )
}

function Body({
  loading,
  analysis,
  partial,
  error
}: {
  loading: boolean
  analysis: AiAnalysis | null
  partial: boolean
  error: unknown
}) {
  const { t } = useTranslation()
  if (loading) return <p className="text-sm text-muted">{t('main.intelligence.loading')}</p>
  if (error !== null) return <ErrorNote error={error} />
  if (analysis === null || (analysis.summary === null && analysis.items.length === 0)) {
    return <p className="text-sm text-muted">{t('main.intelligence.empty')}</p>
  }
  return <AnalysisView analysis={analysis} partial={partial} />
}

function Source({ source, current }: { source: AiAnswerSource; current: string }) {
  const { t } = useTranslation()
  const player = usePlayer()
  const time = source.start === null ? '' : formatTime(source.start)
  if (source.transcriptionId === current && source.start !== null) {
    const start = source.start
    return (
      <li>
        <button
          type="button"
          onClick={() => {
            player.seek(start)
          }}
          className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-2"
        >
          <span className="font-mono text-xs text-accent">{time}</span>
          <span>{source.text}</span>
        </button>
      </li>
    )
  }
  return (
    <li className="flex flex-col px-2 py-1 text-sm">
      <span className="text-xs text-muted">
        {t('main.intelligence.ask.other', { title: source.title ?? '', time })}
      </span>
      <span>{source.text}</span>
    </li>
  )
}

/** Perguntas ao conhecimento (RAG) com as fontes; clique na fonte posiciona o player. */
function AskBox({ transcriptionId }: { transcriptionId: string }) {
  const { t } = useTranslation()
  const api = useApi()
  const id = useId()
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<AiAnswer | null>(null)
  const [error, setError] = useState<unknown>(null)

  const submit = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    // Pergunta vazia não chega aqui: o botão fica desabilitado (e sem ele o Enter não envia).
    const text = question.trim()
    setAsking(true)
    setError(null)
    api.ai
      .ask(text)
      .then(setAnswer, (failure: unknown) => {
        setAnswer(null)
        setError(failure)
      })
      .finally(() => {
        setAsking(false)
      })
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t('main.intelligence.ask.label')}
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            value={question}
            maxLength={500}
            onChange={(event) => {
              setQuestion(event.target.value)
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <Button size="sm" type="submit" disabled={asking || question.trim() === ''}>
            {t(asking ? 'main.intelligence.ask.asking' : 'main.intelligence.ask.submit')}
          </Button>
        </div>
      </form>
      {error !== null && <ErrorNote error={error} />}
      {answer !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-relaxed whitespace-pre-line">{answer.answer}</p>
          {answer.sources.length > 0 && (
            <>
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                {t('main.intelligence.ask.sources')}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {answer.sources.map((source, index) => (
                  <Source
                    key={`${source.transcriptionId ?? ''}-${String(index)}`}
                    source={source}
                    current={transcriptionId}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Actions({
  status,
  transcriptionStatus,
  loading,
  onRetry,
  onReanalyze,
  onRefresh
}: {
  status: AiStatus | null
  transcriptionStatus: JobStatus
  loading: boolean
  onRetry: () => void
  onReanalyze: () => void
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  const failed = status?.enabled === true ? status.failedAnalysis : 0
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {failed > 0 && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('main.intelligence.retry', { count: failed })}
        </Button>
      )}
      {status?.enabled === true && transcriptionStatus === 'done' && (
        <Button size="sm" variant="ghost" onClick={onReanalyze}>
          {t('main.intelligence.reanalyze')}
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh}>
        {t('main.intelligence.refresh')}
      </Button>
    </div>
  )
}

/** Painel "Inteligência": estado da transcrição/IA, a análise e perguntas (plano §20). */
export function IntelligencePanel({
  transcriptionId,
  transcriptionStatus
}: {
  transcriptionId: string
  transcriptionStatus: JobStatus
}) {
  const api = useApi()
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null)
  const [partial, setPartial] = useState(false)
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const fetch = useCallback(
    () =>
      Promise.all([api.ai.analysis(transcriptionId), api.ai.status()])
        .then(([nextAnalysis, nextStatus]) => {
          setAnalysis(nextAnalysis)
          setStatus(nextStatus)
          setError(null)
        })
        .catch((failure: unknown) => {
          setError(failure)
        })
        .finally(() => {
          setLoading(false)
        }),
    [api, transcriptionId]
  )
  useEffect(() => {
    void fetch()
  }, [fetch])

  useEffect(
    () =>
      api.ai.onEvent((event) => {
        if (event.type === 'status') {
          setStatus(event.status)
        } else if (event.type === 'analysis' && event.transcriptionId === transcriptionId) {
          setAnalysis(event.analysis)
          setPartial(!event.final)
          setError(null)
        }
      }),
    [api, transcriptionId]
  )

  const refresh = (): void => {
    setLoading(true)
    void fetch()
  }
  const act = (action: () => Promise<unknown>): void => {
    action().then(refresh, (failure: unknown) => {
      setError(failure)
    })
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <StatusLines status={status} transcriptionStatus={transcriptionStatus} />
        <Actions
          status={status}
          transcriptionStatus={transcriptionStatus}
          loading={loading}
          onRetry={() => {
            act(() => api.ai.retry(transcriptionId))
          }}
          onReanalyze={() => {
            act(() => api.ai.reanalyze(transcriptionId))
          }}
          onRefresh={refresh}
        />
      </div>
      <Body loading={loading} analysis={analysis} partial={partial} error={error} />
      {status?.enabled === true && <AskBox transcriptionId={transcriptionId} />}
    </div>
  )
}
