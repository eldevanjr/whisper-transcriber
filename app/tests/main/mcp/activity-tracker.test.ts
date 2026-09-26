import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ActivityTracker } from '../../../src/main/mcp/activity-tracker'
import type { QueueEvent } from '../../../src/shared/events'
import type { HistoryMeta } from '../../../src/shared/history'

function meta(overrides: Partial<HistoryMeta> = {}): HistoryMeta {
  return {
    id: randomUUID(),
    fileName: 'Reunião equipe.mp4',
    sourcePath: '/v/aula.mp4',
    mediaKind: 'video',
    createdAt: '2026-09-23T10:00:00.000Z',
    status: 'queued',
    model: 'small',
    language: 'pt',
    languageDetected: null,
    duration: null,
    error: null,
    kind: 'file',
    ...overrides
  }
}

function liveMeta(overrides: Partial<HistoryMeta> = {}): HistoryMeta {
  return meta({
    fileName: 'Sessão ao vivo',
    sourcePath: '',
    mediaKind: 'audio',
    status: 'processing',
    kind: 'live',
    tracks: ['voce', 'outros'],
    activeVersion: 'live',
    ...overrides
  })
}

describe('ActivityTracker', () => {
  it('builds current, pending and clears on done', () => {
    const tracker = new ActivityTracker()
    const item = meta({ requestedBy: 'claude-code' })
    tracker.onQueueEvent({ type: 'job', meta: item })
    expect(tracker.snapshot()).toEqual({
      appRunning: true,
      current: null,
      pending: [{ id: item.id, title: 'Reunião equipe.mp4', requestedBy: 'claude-code' }],
      live: null
    })

    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'processing' } })
    tracker.onQueueEvent({ type: 'phase', jobId: item.id, phase: 'transcribing' })
    tracker.onQueueEvent({
      type: 'progress',
      jobId: item.id,
      pct: 40,
      processedS: 40,
      totalS: 100,
      speed: 2
    })
    tracker.onQueueEvent({
      type: 'segment',
      jobId: item.id,
      segment: { start: 39, end: 40, text: 'Olá' }
    })
    expect(tracker.snapshot().current).toEqual({
      id: item.id,
      title: 'Reunião equipe.mp4',
      phase: 'transcribing',
      pct: 40,
      processedS: 40,
      totalS: 100,
      speed: 2,
      etaS: 30,
      requestedBy: 'claude-code'
    })
    expect(tracker.snapshot().pending).toEqual([])

    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'done' } })
    expect(tracker.snapshot()).toEqual({
      appRunning: true,
      current: null,
      pending: [],
      live: null
    })
  })

  it('removed clears the job', () => {
    const tracker = new ActivityTracker()
    const item = meta()
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'processing' } })
    tracker.onQueueEvent({ type: 'removed', jobId: item.id })
    expect(tracker.snapshot().current).toBeNull()
    expect(tracker.snapshot().pending).toEqual([])
    expect(tracker.progressOf(item.id)).toBeNull()
  })

  it('removing and finishing unknown or queued jobs is safe', () => {
    const tracker = new ActivityTracker()
    const current = meta()
    const waiting = meta()
    tracker.onQueueEvent({ type: 'job', meta: current })
    tracker.onQueueEvent({ type: 'job', meta: { ...current, status: 'processing' } })
    tracker.onQueueEvent({ type: 'job', meta: waiting })
    tracker.onQueueEvent({ type: 'removed', jobId: waiting.id })
    tracker.onQueueEvent({ type: 'removed', jobId: randomUUID() })
    expect(tracker.snapshot().current?.id).toBe(current.id)
    expect(tracker.snapshot().pending).toEqual([])
  })

  it('keeps etaS null when speed is zero', () => {
    const tracker = new ActivityTracker()
    const item = meta()
    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'processing' } })
    tracker.onQueueEvent({
      type: 'progress',
      jobId: item.id,
      pct: 10,
      processedS: 10,
      totalS: 100,
      speed: 0
    })
    expect(tracker.snapshot().current?.etaS).toBeNull()
  })

  it('carries the redo track pass', () => {
    const tracker = new ActivityTracker()
    const item = liveMeta({ status: 'queued' })
    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'processing' } })
    tracker.onQueueEvent({
      type: 'progress',
      jobId: item.id,
      pct: 33,
      processedS: 10,
      totalS: 30,
      speed: 1,
      pass: { track: 'outros', index: 1, count: 3 }
    })
    expect(tracker.snapshot().current?.pass).toEqual({ track: 'outros', index: 1, count: 3 })
  })

  it('reports the live session separately from the queue', () => {
    const tracker = new ActivityTracker()
    const item = liveMeta()
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: item.id })
    expect(tracker.snapshot().current).toBeNull()
    expect(tracker.snapshot().live).toEqual({
      id: item.id,
      title: 'Sessão ao vivo',
      startedAt: item.createdAt,
      tracks: ['voce', 'outros']
    })

    tracker.onLive({ type: 'state', state: 'idle', test: false, itemId: null })
    expect(tracker.snapshot().live).toBeNull()
  })

  it('keeps a live session without tracks and drops it when removed', () => {
    const tracker = new ActivityTracker()
    const item = liveMeta({ tracks: undefined })
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: item.id })
    expect(tracker.snapshot().live).toEqual({
      id: item.id,
      title: 'Sessão ao vivo',
      startedAt: item.createdAt
    })
    tracker.onQueueEvent({ type: 'removed', jobId: item.id })
    expect(tracker.snapshot().live).toBeNull()
  })

  it('does not detach a queue job when another item becomes live', () => {
    const tracker = new ActivityTracker()
    const live = liveMeta({ status: 'queued' })
    const file = meta()
    tracker.onQueueEvent({ type: 'job', meta: live })
    tracker.onQueueEvent({ type: 'job', meta: file })
    tracker.onQueueEvent({ type: 'job', meta: { ...file, status: 'processing' } })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: live.id })
    expect(tracker.snapshot().live?.id).toBe(live.id)
    expect(tracker.snapshot().current?.id).toBe(file.id)
  })

  it('keeps a processing item out of current while its live session is active', () => {
    const tracker = new ActivityTracker()
    const live = liveMeta()
    tracker.onQueueEvent({ type: 'job', meta: { ...live, status: 'processing' } })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: live.id })
    tracker.onQueueEvent({ type: 'job', meta: { ...live, status: 'processing' } })
    expect(tracker.snapshot().current).toBeNull()
  })

  it('handles a job requeued and duplicate queued events', () => {
    const tracker = new ActivityTracker()
    const item = meta()
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onQueueEvent({ type: 'job', meta: { ...item, status: 'processing' } })
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onQueueEvent({ type: 'job', meta: item })
    expect(tracker.snapshot().pending).toHaveLength(1)
    expect(tracker.snapshot().current).toBeNull()
  })

  it('progressOf returns the queued job and null for unknown ids', () => {
    const tracker = new ActivityTracker()
    const item = meta()
    const live = liveMeta()
    tracker.onQueueEvent({ type: 'job', meta: item })
    tracker.onQueueEvent({ type: 'job', meta: live })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: live.id })
    expect(tracker.progressOf(item.id)).toMatchObject({
      id: item.id,
      phase: 'loading_model',
      pct: 0
    })
    expect(tracker.progressOf(live.id)).toBeNull()
    expect(tracker.progressOf(randomUUID())).toBeNull()
  })

  it('ignores non-state live events and test or empty live sessions', () => {
    const tracker = new ActivityTracker()
    tracker.onLive({ type: 'segment', track: 'voce', start: 0, end: 1, text: 'x' })
    tracker.onLive({ type: 'state', state: 'recording', test: true, itemId: randomUUID() })
    tracker.onLive({ type: 'state', state: 'recording', test: false, itemId: null })
    tracker.onLive({ type: 'state', state: 'idle', test: false, itemId: randomUUID() })
    expect(tracker.snapshot().live).toBeNull()
  })

  it('ignores notices, segments and patches for unknown jobs', () => {
    const tracker = new ActivityTracker()
    const events: QueueEvent[] = [
      { type: 'notice', jobId: randomUUID(), code: 'CUDA_FALLBACK' },
      { type: 'segment', jobId: randomUUID(), segment: { start: 0, end: 1, text: 'x' } },
      { type: 'phase', jobId: randomUUID(), phase: 'transcribing' },
      { type: 'progress', jobId: randomUUID(), pct: 1, processedS: 1, totalS: 2, speed: 1 }
    ]
    for (const event of events) tracker.onQueueEvent(event)
    expect(tracker.snapshot().current).toBeNull()
    expect(tracker.snapshot().pending).toEqual([])
  })
})
