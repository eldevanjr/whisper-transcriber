import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { ActivityLog } from '../../../src/main/mcp/activity'
import { TranscriptLibrary } from '../../../src/main/mcp/library'
import { MCP_DISABLED_MESSAGE, TRANSCRIPTION_WARNING } from '../../../src/main/mcp/tools-read'
import { clientNameOf, createMcpServer, type BridgePort } from '../../../src/main/mcp/server'
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

// `homedir` controla a pasta Downloads padrão do `export_transcription` (spec §9.5).
const osState = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => osState.home }
})

const READ_TOOLS = [
  'list_transcriptions',
  'search_transcriptions',
  'get_transcription',
  'get_audio',
  'export_transcription'
]
const LABELS = { voce: 'Você', outros: 'Outros' }
const JOB = {
  sourcePath: '/v/aula.mp4',
  mediaKind: 'video' as const,
  model: 'small' as const,
  language: 'pt'
}

interface ContentLite {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

interface ToolResultLite {
  isError?: boolean
  content: ContentLite[]
  structuredContent?: Record<string, unknown>
}

interface TestContext {
  root: string
  settings: Settings
  store: HistoryStore
  library: TranscriptLibrary
  activity: ActivityLog
  server: McpServer
  client: Client
}

function fakeBridge(): BridgePort {
  return {
    activity: async () => ({ appRunning: false, current: null, pending: [], live: null }),
    status: async () => null,
    transcribe: async () => ({ id: randomUUID(), status: 'queued' })
  }
}

async function connect(
  options: {
    enabled?: boolean
    readSettings?: () => Promise<Settings>
  } = {}
): Promise<TestContext> {
  const root = join(await makeTempDir(), 'history')
  const activityDir = await makeTempDir()
  let tick = 0
  const store = new HistoryStore(root, () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++)))
  const library = new TranscriptLibrary(store, LABELS)
  const activity = new ActivityLog(join(activityDir, 'activity.jsonl'))
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    mcp: { enabled: options.enabled ?? true, allowTranscribe: true }
  }
  const server = createMcpServer({
    library,
    activity,
    readSettings: options.readSettings ?? (async () => settings),
    bridge: fakeBridge(),
    version: '9.9.9'
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'claude-code', version: '1.0.0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { root, settings, store, library, activity, server, client }
}

async function doneItem(
  ctx: TestContext,
  texts: string[] = ['Oi'],
  sourcePath = '/v/Reunião equipe.mp4'
) {
  const meta = await ctx.store.create({ ...JOB, sourcePath })
  const entries = texts.map((texto, index) => ({
    inicio: index * 10,
    fim: index * 10 + 1,
    texto
  }))
  await writeFile(ctx.store.paths(meta.id).transcript, JSON.stringify(entries))
  await writeFile(ctx.store.paths(meta.id).audio, Buffer.from('abcd'))
  return ctx.store.update(meta.id, { status: 'done', duration: 5, languageDetected: 'pt' })
}

async function call(ctx: TestContext, name: string, args: Record<string, unknown> = {}) {
  return (await ctx.client.callTool({ name, arguments: args })) as unknown as ToolResultLite
}

function textOf(result: ToolResultLite): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

function promptText(result: { messages: { content: ContentLite }[] }): string {
  return result.messages.map((message) => message.content.text ?? '').join('\n')
}

let open: TestContext[] = []
let openRoots: string[] = []

async function connectTracked(options?: Parameters<typeof connect>[0]): Promise<TestContext> {
  const ctx = await connect(options)
  open.push(ctx)
  openRoots.push(ctx.root)
  return ctx
}

beforeEach(() => {
  open = []
  openRoots = []
})

afterEach(async () => {
  await Promise.all(open.map((ctx) => ctx.client.close()))
  await Promise.all(open.map((ctx) => ctx.server.close()))
  await Promise.all(openRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('createMcpServer tools/list', () => {
  it('exposes the read tools with descriptions and input schemas', async () => {
    const ctx = await connectTracked()
    const { tools } = await ctx.client.listTools()
    const names = tools.map((tool) => tool.name)
    // T7 acrescenta get_activity, get_status e transcribe_file; a Task 4 garante as 5 de leitura.
    for (const name of READ_TOOLS) expect(names).toContain(name)
    const read = tools.filter((tool) => READ_TOOLS.includes(tool.name))
    expect(read).toHaveLength(READ_TOOLS.length)
    for (const tool of read) {
      expect(tool.description).toContain(TRANSCRIPTION_WARNING)
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const props = (name: string) =>
      (byName.get(name)?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    const required = (name: string) =>
      (byName.get(name)?.inputSchema as { required?: string[] }).required ?? []
    expect(Object.keys(props('list_transcriptions'))).toEqual(
      expect.arrayContaining(['query', 'kind', 'status', 'since', 'until', 'limit', 'offset'])
    )
    expect(required('search_transcriptions')).toContain('query')
    expect(required('get_transcription')).toContain('id')
    expect(Object.keys(props('get_transcription'))).toEqual(
      expect.arrayContaining(['id', 'format', 'version', 'from_s', 'to_s', 'cursor'])
    )
    expect(required('get_audio')).toContain('id')
    expect(required('export_transcription')).toContain('id')
  })
})

describe('read tools', () => {
  it('list_transcriptions returns items with the spec field names', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const result = await call(ctx, 'list_transcriptions', {})
    expect(result.isError).toBeFalsy()
    const data = result.structuredContent as { total: number; items: Record<string, unknown>[] }
    expect(data.total).toBe(1)
    expect(data.items[0]).toMatchObject({
      id: item.id,
      title: 'Reunião equipe.mp4',
      createdAt: item.createdAt,
      durationS: 5,
      language: 'pt',
      kind: 'file',
      status: 'done',
      hasRedo: false
    })
    expect(data.items[0]).not.toHaveProperty('start')
    expect(textOf(result)).toContain('Reunião equipe.mp4')
  })

  it('list_transcriptions with an empty history summarizes zero items', async () => {
    const ctx = await connectTracked()
    const result = await call(ctx, 'list_transcriptions', {})
    expect(result.structuredContent).toMatchObject({ total: 0, items: [] })
    expect(textOf(result)).toBe('No transcriptions found.')
  })

  it('search_transcriptions maps start/end to startS/endS and carries the speaker', async () => {
    const ctx = await connectTracked()
    await doneItem(ctx, ['Bom dia. Reunião de equipe hoje.'])
    const live = await ctx.store.createLive({
      title: 'Sessão',
      tracks: ['voce', 'outros'],
      model: 'small',
      language: null
    })
    await ctx.store.appendSegment(live.id, {
      start: 0,
      end: 1,
      text: 'Combinado revisar o contrato',
      speaker: 'voce'
    })
    await ctx.store.update(live.id, { status: 'done' })

    const files = await call(ctx, 'search_transcriptions', { query: 'reuniao' })
    const fileHits = (files.structuredContent as { hits: Record<string, unknown>[] }).hits
    expect(fileHits[0]).toMatchObject({
      title: 'Reunião equipe.mp4',
      startS: 0,
      endS: 1,
      snippet: 'Bom dia. Reunião de equipe hoje.'
    })
    expect(fileHits[0]).not.toHaveProperty('start')
    expect(fileHits[0]).not.toHaveProperty('end')

    const liveHits = await call(ctx, 'search_transcriptions', { query: 'contrato' })
    const hits = (liveHits.structuredContent as { hits: Record<string, unknown>[] }).hits
    expect(hits[0]).toMatchObject({ id: live.id, startS: 0, endS: 1, speaker: 'voce' })
  })

  it('search_transcriptions summarizes no matches', async () => {
    const ctx = await connectTracked()
    await doneItem(ctx, ['Nada por aqui'])
    const result = await call(ctx, 'search_transcriptions', { query: 'achado' })
    expect((result.structuredContent as { hits: unknown[] }).hits).toEqual([])
    expect(textOf(result)).toContain('No matches')
  })

  it('get_transcription returns meta, range, next_cursor, in_progress and total_segments', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const result = await call(ctx, 'get_transcription', { id: item.id })
    expect(result.structuredContent).toMatchObject({
      meta: { id: item.id },
      content: 'Oi',
      range: { fromS: 0, toS: 1 },
      next_cursor: null,
      in_progress: false,
      total_segments: 1
    })
  })

  it('get_transcription paginates and hints the cursor in the text summary', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(
      ctx,
      Array.from({ length: 600 }, (_, index) => `Trecho ${index} ${'x'.repeat(480)}`)
    )
    const result = await call(ctx, 'get_transcription', { id: item.id, format: 'text' })
    const data = result.structuredContent as { next_cursor: string | null }
    expect(data.next_cursor).toBeTruthy()
    expect(textOf(result)).toContain('[next_cursor:')
  })

  it('get_audio returns path, mime, bytes and duration for the mix track', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const result = await call(ctx, 'get_audio', { id: item.id })
    expect(result.structuredContent).toMatchObject({
      path: ctx.store.paths(item.id).audio,
      mime: 'audio/mp4',
      bytes: 4,
      durationS: 5
    })
  })

  it('get_audio embeds audio up to 10 MB and refuses above', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const small = await call(ctx, 'get_audio', { id: item.id, embed: true })
    const audio = small.content.find((block) => block.type === 'audio')
    expect(audio).toMatchObject({
      data: Buffer.from('abcd').toString('base64'),
      mimeType: 'audio/mp4'
    })

    await truncate(ctx.store.paths(item.id).audio, 10 * 1024 * 1024 + 1)
    const large = await call(ctx, 'get_audio', { id: item.id, embed: true })
    expect(large.content.some((block) => block.type === 'audio')).toBe(false)
    expect(textOf(large)).toContain('too large to embed')
    expect(large.structuredContent).toMatchObject({ bytes: 10 * 1024 * 1024 + 1 })
  })

  it('get_audio resolves the original file for track source', async () => {
    const ctx = await connectTracked()
    const dir = await makeTempDir()
    openRoots.push(dir)
    const source = join(dir, 'origem.mp3')
    await writeFile(source, Buffer.from('abc'))
    const meta = await ctx.store.create({ ...JOB, sourcePath: source, mediaKind: 'audio' })
    const result = await call(ctx, 'get_audio', { id: meta.id, track: 'source' })
    expect(result.structuredContent).toMatchObject({ path: source, mime: 'audio/mpeg', bytes: 3 })
  })

  it('export_transcription writes the file next to the requested directory', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const dir = await makeTempDir()
    openRoots.push(dir)
    const result = await call(ctx, 'export_transcription', {
      id: item.id,
      format: 'txt',
      version: 'active',
      directory: dir
    })
    const data = result.structuredContent as { path: string; bytes: number }
    expect(data.path).toBe(join(dir, 'Reunião equipe.txt'))
    expect(data.bytes).toBe((await stat(data.path)).size)
  })

  it('export_transcription defaults to the user Downloads folder', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const home = await makeTempDir()
    openRoots.push(home)
    await mkdir(join(home, 'Downloads'))
    osState.home = home
    const result = await call(ctx, 'export_transcription', { id: item.id })
    expect((result.structuredContent as { path: string }).path).toBe(
      join(home, 'Downloads', 'Reunião equipe.txt')
    )
  })

  it('maps AppError to isError with the code and message', async () => {
    const ctx = await connectTracked()
    const missing = await call(ctx, 'get_transcription', { id: randomUUID() })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('NOT_FOUND')

    const item = await doneItem(ctx)
    const invalid = await call(ctx, 'get_transcription', { id: item.id, from_s: 5, to_s: 1 })
    expect(invalid.isError).toBe(true)
    expect(textOf(invalid)).toContain('INVALID_REQUEST')
  })

  it('maps unexpected errors to INTERNAL without leaking the cause', async () => {
    const ctx = await connectTracked({
      readSettings: async () => {
        throw new Error('boom /secret/path')
      }
    })
    const result = await call(ctx, 'list_transcriptions', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('INTERNAL: Internal error')
  })
})

describe('access key', () => {
  it('refuses every read tool with MCP_DISABLED when access is off', async () => {
    const ctx = await connectTracked({ enabled: false })
    const item = await doneItem(ctx)
    const dir = await makeTempDir()
    openRoots.push(dir)
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: 'list_transcriptions', arguments: {} },
      { name: 'search_transcriptions', arguments: { query: 'oi' } },
      { name: 'get_transcription', arguments: { id: item.id } },
      { name: 'get_audio', arguments: { id: item.id } },
      { name: 'export_transcription', arguments: { id: item.id, directory: dir } }
    ]
    for (const params of calls) {
      const result = await call(ctx, params.name, params.arguments)
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain('MCP_DISABLED')
      expect(textOf(result)).toContain(MCP_DISABLED_MESSAGE)
    }
  })

  it('registers the call with the client name from the handshake', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    await call(ctx, 'get_transcription', { id: item.id })
    const [line] = await ctx.activity.recent()
    expect(line).toMatchObject({
      client: 'claude-code',
      tool: 'get_transcription',
      id: item.id,
      title: 'Reunião equipe.mp4'
    })
  })

  it('records list/search calls without an id', async () => {
    const ctx = await connectTracked()
    await call(ctx, 'list_transcriptions', {})
    const [line] = await ctx.activity.recent()
    expect(line).toMatchObject({ client: 'claude-code', tool: 'list_transcriptions' })
    expect(line?.id).toBeUndefined()
  })

  it('clientNameOf is unknown before initialize and the client name after', async () => {
    const ctx = await connectTracked()
    const fresh = createMcpServer({
      library: ctx.library,
      activity: ctx.activity,
      readSettings: async () => ctx.settings,
      bridge: fakeBridge(),
      version: '9.9.9'
    })
    expect(clientNameOf(fresh)).toBe('unknown')
    expect(clientNameOf(ctx.server)).toBe('claude-code')
  })
})

describe('prompts', () => {
  it('lists the prompts and serves them with the transcription', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx, ['Bom dia.', 'Boa tarde.'])
    const { prompts } = await ctx.client.listPrompts()
    expect(prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(['summarize_transcription', 'meeting_minutes'])
    )

    const summary = await ctx.client.getPrompt({
      name: 'summarize_transcription',
      arguments: { id: item.id }
    })
    expect(promptText(summary)).toContain('Bom dia.')
    expect(promptText(summary).toLowerCase()).toContain('bullet')

    const minutes = await ctx.client.getPrompt({
      name: 'meeting_minutes',
      arguments: { id: item.id }
    })
    expect(promptText(minutes)).toContain('[00:00 - 00:01]')
  })

  it('tells the model to continue with the cursor when there is more', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(
      ctx,
      Array.from({ length: 600 }, (_, index) => `Trecho ${index} ${'y'.repeat(480)}`)
    )
    const summary = await ctx.client.getPrompt({
      name: 'summarize_transcription',
      arguments: { id: item.id }
    })
    expect(promptText(summary)).toContain('get_transcription')
  })

  it('refuses prompts when access is off', async () => {
    const ctx = await connectTracked({ enabled: false })
    const item = await doneItem(ctx)
    await expect(
      ctx.client.getPrompt({ name: 'summarize_transcription', arguments: { id: item.id } })
    ).rejects.toThrow(MCP_DISABLED_MESSAGE)
  })
})

describe('resources', () => {
  it('lists the 20 most recent done items and reads one as text', async () => {
    const ctx = await connectTracked()
    const item = await doneItem(ctx)
    const { resources } = await ctx.client.listResources()
    const uri = `transcription://${item.id}`
    expect(resources.find((resource) => resource.uri === uri)).toMatchObject({
      name: 'Reunião equipe.mp4',
      mimeType: 'text/plain'
    })
    const read = await ctx.client.readResource({ uri })
    expect(read.contents[0]).toMatchObject({
      uri,
      mimeType: 'text/plain',
      text: 'Oi'
    })
  })

  it('limits the resource list to the 20 most recent done items', async () => {
    const ctx = await connectTracked()
    for (let index = 0; index < 21; index++) {
      const meta = await ctx.store.create({ ...JOB, sourcePath: `/v/${index}.mp4` })
      await ctx.store.update(meta.id, { status: 'done' })
    }
    const { resources } = await ctx.client.listResources()
    expect(resources).toHaveLength(20)
  })

  it('serves nothing and refuses reads when access is off', async () => {
    const ctx = await connectTracked({ enabled: false })
    const { resources } = await ctx.client.listResources()
    expect(resources).toEqual([])
    await expect(
      ctx.client.readResource({ uri: `transcription://${randomUUID()}` })
    ).rejects.toThrow(MCP_DISABLED_MESSAGE)
  })
})
