import type { LiveEvent, QueueEvent } from '../../shared/events'
import type { AiSegmentInput } from '../worker/protocol'

/** A cada ~30 s de fala nova, um lote vai para a análise (ela acompanha a transcrição). */
export const APPEND_SPAN_SECONDS = 30
const LIVE_FALLBACK_TITLE = 'Ao vivo'

interface SubmitInput {
  transcriptionId: string
  title: string
  segments: AiSegmentInput[]
}

/** O que o indexador precisa da sessão de IA (facilita o dublê nos testes). */
export interface TranscriptionSubmitter {
  submit(input: SubmitInput): Promise<void>
  append(input: SubmitInput): Promise<void>
  forget(transcriptionId: string): Promise<void>
}

export interface TranscriptionIndexerDeps {
  session: TranscriptionSubmitter
  logger: { warn(message: string): void }
  /** Título do item do histórico (as sessões ao vivo só avisam o id). */
  titleOf: (id: string) => Promise<string>
}

interface Tracked {
  title: Promise<string>
  segments: AiSegmentInput[]
  sent: number
  batchStart: number | null
}

/**
 * Alimenta a análise/indexação a partir das transcrições do app.
 *
 * Arquivos (eventos da fila) e gravações ao vivo (eventos do ao vivo): os
 * segmentos vão em lotes enquanto a transcrição anda e, no fim, a transcrição
 * inteira é enviada. Excluir do histórico apaga o conhecimento derivado. Nada
 * aqui bloqueia a fila: os envios são encadeados por transcrição, em segundo plano.
 */
export class TranscriptionIndexer {
  private readonly tracked = new Map<string, Tracked>()
  private readonly chains = new Map<string, Promise<void>>()
  private liveId: string | null = null

  constructor(private readonly deps: TranscriptionIndexerDeps) {}

  onEvent(event: QueueEvent): void {
    switch (event.type) {
      case 'job': {
        const { id, status, fileName } = event.meta
        if (status === 'processing') this.start(id, Promise.resolve(fileName))
        else if (status === 'done') this.finish(id)
        else if (status === 'failed' || status === 'canceled') this.tracked.delete(id)
        return
      }
      case 'segment':
        this.add(event.jobId, event.segment)
        return
      case 'removed':
        this.tracked.delete(event.jobId)
        this.enqueue(event.jobId, () => this.deps.session.forget(event.jobId))
        return
      default:
        return
    }
  }

  onLiveEvent(event: LiveEvent): void {
    if (event.type === 'segment') {
      if (this.liveId !== null) this.add(this.liveId, event)
      return
    }
    if (event.type !== 'state' || event.test) return
    if (event.itemId !== null && this.liveId === null) {
      this.liveId = event.itemId
      this.start(event.itemId, this.liveTitle(event.itemId))
    } else if (event.state === 'idle' && this.liveId !== null) {
      this.finish(this.liveId)
      this.liveId = null
    }
  }

  private liveTitle(id: string): Promise<string> {
    return this.deps.titleOf(id).catch(() => LIVE_FALLBACK_TITLE)
  }

  private start(id: string, title: Promise<string>): void {
    this.tracked.set(id, { title, segments: [], sent: 0, batchStart: null })
  }

  private add(id: string, segment: { start: number; end: number; text: string }): void {
    const tracked = this.tracked.get(id)
    if (!tracked) return
    tracked.segments.push({
      index: tracked.segments.length,
      start: segment.start,
      end: segment.end,
      text: segment.text
    })
    tracked.batchStart ??= segment.start
    if (segment.start - tracked.batchStart < APPEND_SPAN_SECONDS) return
    const batch = tracked.segments.slice(tracked.sent)
    tracked.sent = tracked.segments.length
    tracked.batchStart = null
    this.enqueue(id, async () => {
      await this.deps.session.append({
        transcriptionId: id,
        title: await tracked.title,
        segments: batch
      })
    })
  }

  private finish(id: string): void {
    const tracked = this.tracked.get(id)
    if (!tracked) return
    this.tracked.delete(id)
    this.enqueue(id, async () => {
      await this.deps.session.submit({
        transcriptionId: id,
        title: await tracked.title,
        segments: tracked.segments
      })
    })
  }

  /** Mantém a ordem dos envios de cada transcrição; uma falha não trava os próximos. */
  private enqueue(id: string, task: () => Promise<void>): void {
    const previous = this.chains.get(id) ?? Promise.resolve()
    const next = previous.then(task).catch((error: unknown) => {
      this.deps.logger.warn(`[ia] falha ao enviar ${id} para a análise: ${String(error)}`)
    })
    this.chains.set(id, next)
    void next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id)
    })
  }
}
