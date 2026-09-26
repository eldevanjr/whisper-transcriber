import type { LiveEvent, Phase, QueueEvent, TrackPass } from '../../shared/events'
import type { HistoryMeta } from '../../shared/history'
import type { ActivitySnapshot, JobProgress, LiveActivity, PendingJob } from '../../shared/mcp'

interface ProgressState {
  pct: number
  processedS: number
  totalS: number
  speed: number
  pass?: TrackPass
}

interface TrackedJob {
  meta: HistoryMeta
  phase: Phase
  progress: ProgressState | null
}

const DEFAULT_PHASE: Phase = 'loading_model'
const NO_PROGRESS: ProgressState = { pct: 0, processedS: 0, totalS: 0, speed: 0 }

/**
 * Retrato do que o app está fazendo a partir dos eventos da fila e do ao vivo (spec §7.4).
 * Sempre servido pela ponte com `appRunning: true`; nada de texto de transcrição é guardado.
 */
export class ActivityTracker {
  private readonly jobs = new Map<string, TrackedJob>()
  private readonly queued: TrackedJob[] = []
  private currentId: string | null = null
  private activeLiveId: string | null = null

  onQueueEvent(event: QueueEvent): void {
    switch (event.type) {
      case 'job':
        this.onJob(event.meta)
        return
      case 'removed':
        this.forget(event.jobId)
        return
      case 'phase':
        this.patch(event.jobId, (job) => {
          job.phase = event.phase
        })
        return
      case 'progress':
        this.patch(event.jobId, (job) => {
          job.progress = progressState(event)
        })
        return
      default:
    }
  }

  onLive(event: LiveEvent): void {
    if (event.type !== 'state') return
    const active = event.itemId !== null && !event.test && event.state !== 'idle'
    this.activeLiveId = active ? event.itemId : null
    if (this.activeLiveId !== null) this.detachLive(this.activeLiveId)
  }

  snapshot(): ActivitySnapshot {
    return {
      appRunning: true,
      current: this.currentId === null ? null : this.progressOf(this.currentId),
      pending: this.pending(),
      live: this.live()
    }
  }

  progressOf(id: string): JobProgress | null {
    const job = this.jobs.get(id)
    if (job === undefined) return null
    const inQueue = id === this.currentId || this.queued.some((queued) => queued.meta.id === id)
    return inQueue ? toProgress(job) : null
  }

  private onJob(meta: HistoryMeta): void {
    const existing = this.jobs.get(meta.id)
    const job: TrackedJob = existing ?? { meta, phase: DEFAULT_PHASE, progress: null }
    job.meta = meta
    this.jobs.set(meta.id, job)
    if (meta.status === 'processing') this.markCurrent(job)
    else if (meta.status === 'queued') this.markQueued(job)
    else this.forget(meta.id)
  }

  private markCurrent(job: TrackedJob): void {
    this.currentId = this.activeLiveId === job.meta.id ? null : job.meta.id
    this.removeQueued(job.meta.id)
  }

  private markQueued(job: TrackedJob): void {
    if (this.currentId === job.meta.id) this.currentId = null
    if (!this.queued.includes(job)) this.queued.push(job)
  }

  private forget(id: string): void {
    this.jobs.delete(id)
    this.removeQueued(id)
    if (this.currentId === id) this.currentId = null
  }

  /** Remove da visão da fila o item que virou sessão ao vivo. */
  private detachLive(id: string): void {
    if (this.currentId === id) this.currentId = null
    this.removeQueued(id)
  }

  private removeQueued(id: string): void {
    const index = this.queued.findIndex((job) => job.meta.id === id)
    if (index >= 0) this.queued.splice(index, 1)
  }

  private patch(id: string, apply: (job: TrackedJob) => void): void {
    const job = this.jobs.get(id)
    if (job) apply(job)
  }

  private pending(): PendingJob[] {
    return this.queued.map((job) => ({
      id: job.meta.id,
      title: job.meta.fileName,
      ...(job.meta.requestedBy === undefined ? {} : { requestedBy: job.meta.requestedBy })
    }))
  }

  private live(): LiveActivity | null {
    if (this.activeLiveId === null) return null
    const meta = this.jobs.get(this.activeLiveId)?.meta
    if (!meta) return null
    return {
      id: meta.id,
      title: meta.fileName,
      startedAt: meta.createdAt,
      ...(meta.tracks === undefined ? {} : { tracks: meta.tracks })
    }
  }
}

function progressState(event: Extract<QueueEvent, { type: 'progress' }>): ProgressState {
  return {
    pct: event.pct,
    processedS: event.processedS,
    totalS: event.totalS,
    speed: event.speed,
    ...(event.pass === undefined ? {} : { pass: event.pass })
  }
}

function toProgress(job: TrackedJob): JobProgress {
  const progress = job.progress ?? NO_PROGRESS
  const result: JobProgress = {
    id: job.meta.id,
    title: job.meta.fileName,
    phase: job.phase,
    pct: progress.pct,
    processedS: progress.processedS,
    totalS: progress.totalS,
    speed: progress.speed,
    etaS: etaOf(progress)
  }
  if (job.meta.requestedBy !== undefined) result.requestedBy = job.meta.requestedBy
  if (progress.pass !== undefined) result.pass = progress.pass
  return result
}

function etaOf(progress: ProgressState): number | null {
  if (progress.speed <= 0) return null
  return (progress.totalS - progress.processedS) / progress.speed
}
