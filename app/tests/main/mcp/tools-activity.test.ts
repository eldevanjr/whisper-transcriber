import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { ActivityLog } from '../../../src/main/mcp/activity'
import { TranscriptLibrary } from '../../../src/main/mcp/library'
import { createMcpServer, type BridgePort } from '../../../src/main/mcp/server'
import { TRANSCRIPTION_WARNING } from '../../../src/main/mcp/tools-read'
import { AppError } from '../../../src/shared/errors'
import type { ActivitySnapshot, JobProgress } from '../../../src/shared/mcp'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

const LABELS = { voce: 'Você', outros: 'Outros' }
const JOB = {
  sourcePath: '/v/aula.mp4',
  mediaKind: 'video' as const,
  model: 'small' as const,
  language: 'pt'
}
const CLOSED: ActivitySnapshot = {
  appRunning: false,
  current: null,
  pending: [],
  live: null
}

interface ContentLite {
  type: string
  text?: string
}
interface ToolResultLite {
  isError?: boolean
  content: ContentLite[]
  structuredContent?: Record<string, unknown>
}

function fakeBridge(overrides: Partial<BridgePort> = {}): BridgePort {
  return {
    activity: async () => CLOSED,
    status: async () => null,
    transcribe: async () => ({ id: randomUUID(), status: 'queued', position: 1 }),
    ...overrides
  }
}

function progress(overrides: Partial<JobProgress> = {}): JobProgress {
  return {
    id: randomUUID(),
    title: 'aula.mp4',
    phase: 'transcribing',
    pct: 42,
    processedS: 42,
    totalS: 100,
    speed: 2,
    etaS: 29,
    ...overrides
  }
}

interface TestContext {
  root: string
  store: HistoryStore
  library: TranscriptLibrary
  server: McpServer
  client: Client
}

interface StartOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type Configure = (store: HistoryStore) => Promise<{ bridge: BridgePort } & StartOptions>

async function open(configure: Configure): Promise<TestContext> {
  const root = join(await makeTempDir(), 'history')
  const activityDir = await makeTempDir()
  const store = new HistoryStore(root)
  const library = new TranscriptLibrary(store, LABELS)
  const { bridge, now, sleep } = await configure(store)
  const server = createMcpServer({
    library,
    activity: new ActivityLog(join(activityDir, 'activity.jsonl')),
    readSettings: async () => ({
      ...DEFAULT_SETTINGS,
      model: 'small',
      mcp: { enabled: true, allowTranscribe: true }
    }),
    bridge,
    version: '9.9.9',
    ...(now ? { now } : {}),
    ...(sleep ? { sleep } : {})
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { root, store, library, server, client }
}

async function call(
  ctx: TestContext,
  name: string,
  args: Record<string, unknown> = {},
  options?: {
    onprogress?: (value: { progress: number; total?: number; message?: string }) => void
  }
): Promise<ToolResultLite> {
  return (await ctx.client.callTool(
    { name, arguments: args },
    undefined,
    options
  )) as unknown as ToolResultLite
}

function textOf(result: ToolResultLite): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

let openContexts: TestContext[] = []
let extras: string[] = []

async function tracked(configure: Configure): Promise<TestContext> {
  const context = await open(configure)
  openContexts.push(context)
  return context
}

async function mediaFile(name = 'aula.mp4', body = 'x'): Promise<string> {
  const dir = await makeTempDir()
  extras.push(dir)
  const path = join(dir, name)
  await writeFile(path, body)
  return path
}

beforeEach(() => {
  openContexts = []
  extras = []
})

afterEach(async () => {
  await Promise.all(openContexts.map((ctx) => ctx.client.close()))
  await Promise.all(openContexts.map((ctx) => ctx.server.close()))
  await Promise.all(openContexts.map((ctx) => rm(ctx.root, { recursive: true, force: true })))
  await Promise.all(extras.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('activity tool descriptions', () => {
  it('carry the transcription warning on all three tools', async () => {
    const ctx = await tracked(async () => ({ bridge: fakeBridge() }))
    const { tools } = await ctx.client.listTools()
    for (const name of ['get_activity', 'get_status', 'transcribe_file']) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool?.description).toContain(TRANSCRIPTION_WARNING)
    }
  })
})

describe('get_activity', () => {
  it('marks disk items as stalled when the app is closed', async () => {
    const ctx = await tracked(async () => ({ bridge: fakeBridge() }))
    const queued = await ctx.store.create({ ...JOB, sourcePath: '/v/um.mp4' })
    const processing = await ctx.store.create({ ...JOB, sourcePath: '/v/dois.mp4' })
    await ctx.store.update(processing.id, { status: 'processing' })

    const result = await call(ctx, 'get_activity')
    expect(result.isError).toBeFalsy()
    const data = result.structuredContent as { stalled: { id: string; status: string }[] }
    expect(data).toMatchObject({ app_running: false, current: null, live: null })
    const stalledIds = data.stalled.map((item) => item.id)
    expect(stalledIds).toContain(queued.id)
    expect(stalledIds).toContain(processing.id)
    expect(data.stalled.find((item) => item.id === queued.id)?.status).toBe('queued')
    expect(data.stalled.find((item) => item.id === processing.id)?.status).toBe('processing')
    expect(textOf(result)).toContain('not running')
  })

  it('falls back to the disk when the bridge is unreachable', async () => {
    const ctx = await tracked(async (store) => {
      await store.create({ ...JOB, sourcePath: '/v/off.mp4' })
      return {
        bridge: fakeBridge({
          activity: async () => {
            throw new AppError('WORKER_UNAVAILABLE', 'closed')
          }
        })
      }
    })
    const result = await call(ctx, 'get_activity')
    const data = result.structuredContent as { stalled: unknown[] }
    expect(result.structuredContent).toMatchObject({ app_running: false })
    expect(data.stalled).toHaveLength(1)
  })

  it('maps an unexpected activity error to INTERNAL', async () => {
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        activity: async () => {
          throw new AppError('INTERNAL', 'boom')
        }
      })
    }))
    const result = await call(ctx, 'get_activity')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('INTERNAL')
  })

  it('maps the open app snapshot to the spec field names', async () => {
    const currentId = randomUUID()
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        activity: async () => ({
          appRunning: true,
          current: progress({
            id: currentId,
            requestedBy: 'codex',
            pass: { track: 'voce', index: 1, count: 2 }
          }),
          pending: [{ id: randomUUID(), title: 'fila.mp4', requestedBy: 'claude-code' }],
          live: {
            id: randomUUID(),
            title: 'Sessão',
            startedAt: '2026-09-23T10:00:00.000Z',
            tracks: ['voce']
          }
        })
      })
    }))
    const result = await call(ctx, 'get_activity')
    const data = result.structuredContent!
    expect(data).toMatchObject({
      app_running: true,
      current: {
        id: currentId,
        phase: 'transcribing',
        pct: 42,
        processed_s: 42,
        total_s: 100,
        speed: 2,
        eta_s: 29,
        pass: { track: 'voce', index: 1, count: 2 },
        requested_by: 'codex'
      },
      pending: [{ title: 'fila.mp4', requested_by: 'claude-code' }],
      live: { title: 'Sessão', started_at: '2026-09-23T10:00:00.000Z', tracks: ['voce'] }
    })
    expect(data).not.toHaveProperty('stalled')
  })

  it('keeps nulls when nothing is running', async () => {
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        activity: async () => ({
          appRunning: true,
          current: progress(),
          pending: [{ id: randomUUID(), title: 'fila.mp4' }],
          live: { id: randomUUID(), title: 'Sessão', startedAt: '2026-09-23T10:00:00.000Z' }
        })
      })
    }))
    const result = await call(ctx, 'get_activity')
    const data = result.structuredContent as {
      current: { pass: unknown; requested_by: unknown }
      pending: { requested_by: unknown }[]
      live: { tracks: unknown }
    }
    expect(data.current.pass).toBeNull()
    expect(data.current.requested_by).toBeNull()
    expect(data.pending[0]?.requested_by).toBeNull()
    expect(data.live.tracks).toEqual([])
  })

  it('reports no activity when the app is open but idle', async () => {
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        activity: async () => ({ appRunning: true, current: null, pending: [], live: null })
      })
    }))
    const result = await call(ctx, 'get_activity')
    expect(result.structuredContent).toMatchObject({
      app_running: true,
      current: null,
      pending: [],
      live: null
    })
  })
})

describe('get_status', () => {
  it('returns the app progress and the new segments', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/s.mp4' })
      await store.appendSegment(meta.id, { start: 0, end: 1, text: 'um' })
      await store.appendSegment(meta.id, { start: 1, end: 2, text: 'dois', speaker: 'voce' })
      return { bridge: fakeBridge({ status: async () => progress({ id: meta.id, pct: 50 }) }) }
    })
    const id = (await ctx.store.list()).entries[0]!.id

    const first = await call(ctx, 'get_status', { id, after: 0 })
    expect(first.structuredContent).toMatchObject({
      status: 'queued',
      phase: 'transcribing',
      pct: 50,
      eta_s: 29,
      next_after: 2,
      done: false,
      segments: [
        { start: 0, end: 1, text: 'um' },
        { start: 1, end: 2, text: 'dois', speaker: 'voce' }
      ]
    })
    const second = await call(ctx, 'get_status', { id, after: 2 })
    expect((second.structuredContent as { segments: unknown[] }).segments).toEqual([])
    expect((second.structuredContent as { next_after: number }).next_after).toBe(2)

    await ctx.store.update(id, { status: 'done' })
    const done = await call(ctx, 'get_status', { id, after: 0 })
    expect(done.structuredContent).toMatchObject({ done: true })
  })

  it('omits the queue fields when the app has no progress for the item', async () => {
    const ctx = await tracked(async (store) => {
      await store.create({ ...JOB, sourcePath: '/v/n.mp4' })
      return { bridge: fakeBridge() }
    })
    const id = (await ctx.store.list()).entries[0]!.id
    const result = await call(ctx, 'get_status', { id })
    const data = result.structuredContent!
    expect(data).toMatchObject({ status: 'queued', segments: [], next_after: 0, done: false })
    expect(data).not.toHaveProperty('phase')
  })

  it('never repeats nor skips when the partial grows out of order', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/oo.mp4' })
      await store.appendSegment(meta.id, { start: 5, end: 6, text: 'cinco' })
      return { bridge: fakeBridge() }
    })
    const id = (await ctx.store.list()).entries[0]!.id
    const first = await call(ctx, 'get_status', { id, after: 0 })
    expect(first.structuredContent).toMatchObject({
      next_after: 1,
      segments: [{ start: 5, end: 6, text: 'cinco' }]
    })
    await ctx.store.appendSegment(id, { start: 1, end: 2, text: 'um' })
    const second = await call(ctx, 'get_status', { id, after: 1 })
    expect(second.structuredContent).toMatchObject({
      next_after: 2,
      segments: [{ start: 1, end: 2, text: 'um' }]
    })
  })

  it('reports a missing item as NOT_FOUND', async () => {
    const ctx = await tracked(async () => ({ bridge: fakeBridge() }))
    const result = await call(ctx, 'get_status', { id: randomUUID() })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('NOT_FOUND')
  })

  it('still serves segments when the app is closed', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/closed.mp4' })
      await store.appendSegment(meta.id, { start: 0, end: 1, text: 'um' })
      return {
        bridge: fakeBridge({
          status: async () => {
            throw new AppError('WORKER_UNAVAILABLE', 'closed')
          }
        })
      }
    })
    const id = (await ctx.store.list()).entries[0]!.id
    const result = await call(ctx, 'get_status', { id })
    expect(result.structuredContent).toMatchObject({
      status: 'queued',
      segments: [{ start: 0, end: 1, text: 'um' }]
    })
    expect(result.structuredContent).not.toHaveProperty('phase')
  })

  it('maps an unexpected status error to INTERNAL', async () => {
    const ctx = await tracked(async (store) => {
      await store.create({ ...JOB, sourcePath: '/v/err.mp4' })
      return {
        bridge: fakeBridge({
          status: async () => {
            throw new AppError('INTERNAL', 'boom')
          }
        })
      }
    })
    const id = (await ctx.store.list()).entries[0]!.id
    const result = await call(ctx, 'get_status', { id })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('INTERNAL')
  })
})

describe('transcribe_file', () => {
  it('returns queued and position without waiting', async () => {
    const ctx = await tracked(async () => ({ bridge: fakeBridge() }))
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile() })
    expect(result.structuredContent).toMatchObject({ status: 'queued', position: 1 })
    expect(textOf(result)).toContain('aula.mp4')
  })

  it('reports a null position when the bridge omits it', async () => {
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({ transcribe: async () => ({ id: randomUUID(), status: 'queued' }) })
    }))
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile() })
    expect(result.structuredContent).toMatchObject({ status: 'queued', position: null })
  })

  it('returns the failure error when the item fails while waiting', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/f.mp4' })
      await store.update(meta.id, {
        status: 'failed',
        error: { code: 'INTERNAL', message: 'boom' }
      })
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id: meta.id, status: 'queued', position: 1 }),
          status: async () => progress({ id: meta.id })
        })
      }
    })
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(result.structuredContent).toMatchObject({
      status: 'failed',
      error: { code: 'INTERNAL', message: 'boom' }
    })
  })

  it('propagates a non-availability error while waiting', async () => {
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        transcribe: async () => ({ id: randomUUID(), status: 'queued', position: 1 }),
        status: async () => {
          throw new AppError('INTERNAL', 'boom')
        }
      })
    }))
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('INTERNAL')
  })

  it('tells the AI to poll again when the app has no progress and the item is running', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/r.mp4' })
      await store.update(meta.id, { status: 'processing' })
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id: meta.id, status: 'queued', position: 1 }),
          status: async () => null
        })
      }
    })
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(textOf(result)).toContain('still running')
  })

  it('waits and finishes with the final status', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/w.mp4' })
      await store.update(meta.id, { status: 'done' })
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id: meta.id, status: 'queued', position: 1 }),
          status: async () => progress({ id: meta.id, pct: 100 })
        })
      }
    })
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    const data = result.structuredContent!
    expect(data).toMatchObject({ status: 'done' })
    expect(data.id).toBe((await ctx.store.list()).entries[0]!.id)
  })

  it('sends progress notifications when the client asks for them', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/n.mp4' })
      await store.update(meta.id, { status: 'done' })
      const id = meta.id
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id, status: 'queued', position: 1 }),
          status: async () => progress({ id, pct: 60 })
        })
      }
    })
    const seen: { progress: number; total?: number; message?: string }[] = []
    const result = await call(
      ctx,
      'transcribe_file',
      { path: await mediaFile(), wait: true },
      {
        onprogress: (value) => {
          seen.push(value)
        }
      }
    )
    expect(result.structuredContent).toMatchObject({ status: 'done' })
    expect(seen[0]).toEqual({ progress: 60, total: 100, message: 'transcribing' })
  })

  it('finishes from disk even without bridge progress', async () => {
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/d.mp4' })
      await store.update(meta.id, { status: 'done' })
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id: meta.id, status: 'queued', position: 1 }),
          status: async () => null
        })
      }
    })
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(result.structuredContent).toMatchObject({ status: 'done' })
  })

  it('returns the id and points to get_status when the bridge drops', async () => {
    const itemId = randomUUID()
    const ctx = await tracked(async () => ({
      bridge: fakeBridge({
        transcribe: async () => ({ id: itemId, status: 'queued', position: 1 }),
        status: async () => {
          throw new AppError('WORKER_UNAVAILABLE', 'bridge down')
        }
      })
    }))
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(itemId)
    expect(textOf(result)).toContain('get_status')
  })

  it('returns after 10 min telling the AI to poll again', async () => {
    const itemId = randomUUID()
    const clock = { time: 0 }
    const ctx = await tracked(async (store) => {
      const meta = await store.create({ ...JOB, sourcePath: '/v/t.mp4' })
      await store.update(meta.id, { status: 'processing' })
      return {
        bridge: fakeBridge({
          transcribe: async () => ({ id: meta.id, status: 'queued', position: 1 }),
          status: async () => progress({ id: meta.id, pct: 30 })
        }),
        now: () => clock.time,
        sleep: async (ms: number) => {
          clock.time += ms
        }
      }
    })
    const result = await call(ctx, 'transcribe_file', { path: await mediaFile(), wait: true })
    expect(textOf(result)).toContain('still running')
    expect(textOf(result)).toContain('get_status')
    expect(itemId).toBeDefined()
  })

  it('rejects bad paths before opening the app', async () => {
    const transcribe = vi.fn(async () => ({ id: randomUUID(), status: 'queued' as const }))
    const ctx = await tracked(async () => ({ bridge: fakeBridge({ transcribe }) }))

    const relative = await call(ctx, 'transcribe_file', { path: 'rel.mp4' })
    expect(relative.isError).toBe(true)
    expect(textOf(relative)).toContain('INVALID_REQUEST')

    const unsupported = await call(ctx, 'transcribe_file', { path: '/tmp/nota.pdf' })
    expect(textOf(unsupported)).toContain('UNSUPPORTED_FILE')

    const missing = await call(ctx, 'transcribe_file', {
      path: `/tmp/missing-${randomUUID()}.mp4`
    })
    expect(textOf(missing)).toContain('FILE_NOT_FOUND')

    const dir = await makeTempDir()
    extras.push(dir)
    const asDir = join(dir, 'pasta.mp4')
    await mkdir(asDir)
    const notFile = await call(ctx, 'transcribe_file', { path: asDir })
    expect(textOf(notFile)).toContain('FILE_NOT_FOUND')

    expect(transcribe).not.toHaveBeenCalled()
  })
})
