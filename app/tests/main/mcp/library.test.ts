import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { TranscriptLibrary } from '../../../src/main/mcp/library'
import { AppError } from '../../../src/shared/errors'
import { paragraphsToText, toParagraphs } from '../../../src/shared/format'
import type { Segment, TranscriptEntry } from '../../../src/shared/history'
import { makeTempDir } from '../../helpers/tmp'

const JOB = {
  sourcePath: '/v/aula.mp4',
  mediaKind: 'video' as const,
  model: 'small' as const,
  language: 'pt'
}
const LABELS = { voce: 'Você', outros: 'Outros' }
const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

interface Ctx {
  root: string
  store: HistoryStore
  library: TranscriptLibrary
}

let ctx: Ctx

async function setup(): Promise<Ctx> {
  const root = join(await makeTempDir(), 'history')
  let tick = 0
  const store = new HistoryStore(root, () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++)))
  return { root, store, library: new TranscriptLibrary(store, LABELS) }
}

function entriesOf(...texts: string[]): TranscriptEntry[] {
  return texts.map((texto, index) => ({ inicio: index * 10, fim: index * 10 + 1, texto }))
}

async function doneItem(store: HistoryStore, sourcePath: string, texts: string[] = ['Oi']) {
  const meta = await store.create({ ...JOB, sourcePath })
  await writeFile(store.paths(meta.id).transcript, JSON.stringify(entriesOf(...texts)))
  return store.update(meta.id, { status: 'done', duration: 5, languageDetected: 'pt' })
}

async function liveItem(store: HistoryStore, title: string, segments: Segment[] = []) {
  const meta = await store.createLive({
    title,
    tracks: ['voce', 'outros'],
    model: 'small',
    language: null
  })
  for (const segment of segments) await store.appendSegment(meta.id, segment)
  return meta
}

async function writeEntries(store: HistoryStore, id: string, entries: TranscriptEntry[]) {
  await writeFile(store.paths(id).transcript, JSON.stringify(entries))
}

beforeEach(async () => {
  ctx = await setup()
})

afterEach(async () => {
  await rm(ctx.root, { recursive: true, force: true })
})

describe('TranscriptLibrary.list', () => {
  it('filtros combinados, ordenação e total', async () => {
    const { store, library } = ctx
    const a = await doneItem(store, '/v/Reunião equipe.mp4')
    const b = await doneItem(store, '/v/Aula.mp4')
    await store.update(b.id, {
      status: 'failed',
      error: { code: 'WORKER_CRASHED', message: 'caiu' }
    })
    const c = await liveItem(store, 'Reunião 23/09', [
      { start: 0, end: 1, text: 'oi', speaker: 'voce' }
    ])

    const all = await library.list()
    expect(all.total).toBe(3)
    expect(all.items.map((item) => item.id)).toEqual([c.id, b.id, a.id])

    const reuniao = await library.list({ query: 'reuniao' })
    expect(reuniao.items.map((item) => item.id)).toEqual([c.id, a.id])

    const files = await library.list({ kind: 'file' })
    expect(files.items.map((item) => item.id)).toEqual([b.id, a.id])

    const failed = await library.list({ status: 'failed' })
    expect(failed.items).toHaveLength(1)
    expect(failed.items[0]).toMatchObject({
      id: b.id,
      error: { code: 'WORKER_CRASHED', message: 'caiu' }
    })

    const paged = await library.list({ offset: 1, limit: 1 })
    expect(paged.items.map((item) => item.id)).toEqual([b.id])
    expect(paged.total).toBe(3)
  })

  it('since e until filtram por createdAt', async () => {
    const { store, library } = ctx
    await doneItem(store, '/v/a.mp4')
    const b = await doneItem(store, '/v/b.mp4')
    await doneItem(store, '/v/c.mp4')
    const range = await library.list({
      since: '2026-09-23T10:00:01.000Z',
      until: '2026-09-23T10:00:01.000Z'
    })
    expect(range.items.map((item) => item.id)).toEqual([b.id])
  })

  it('item traz título, duração, idioma, faixas, hasRedo e requestedBy', async () => {
    const { store, library } = ctx
    const live = await liveItem(store, 'Sessão', [
      { start: 0, end: 1, text: 'oi', speaker: 'voce' }
    ])
    await store.update(live.id, { requestedBy: 'codex' })
    const list = await library.list()
    expect(list.items[0]).toMatchObject({
      id: live.id,
      title: 'Sessão',
      durationS: null,
      language: null,
      kind: 'live',
      status: 'processing',
      tracks: ['voce', 'outros'],
      requestedBy: 'codex',
      hasRedo: false
    })
  })

  it('hasRedo fica true depois de refazer o ao vivo', async () => {
    const { store, library } = ctx
    const meta = await liveItem(store, 'R')
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await store.finalizeLive(meta.id)
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(meta.id)
    const list = await library.list()
    expect(list.items[0]?.hasRedo).toBe(true)
  })

  it('ignora itens corrompidos', async () => {
    const { store, library, root } = ctx
    const a = await doneItem(store, '/v/a.mp4')
    const corrupt = join(root, '99999999-9999-4999-8999-999999999999')
    await mkdir(corrupt)
    await writeFile(join(corrupt, 'meta.json'), '{quebrado')
    const list = await library.list()
    expect(list.total).toBe(1)
    expect(list.items[0]?.id).toBe(a.id)
  })

  it('limit acima de 100 vira 100', async () => {
    const { store, library } = ctx
    for (let i = 0; i < 105; i++) await store.create({ ...JOB, sourcePath: `/v/${i}.mp4` })
    const list = await library.list({ limit: 1000 })
    expect(list.items).toHaveLength(100)
    expect(list.total).toBe(105)
  })
})

describe('TranscriptLibrary.search', () => {
  it('acha sem maiúsculas nem acentos e preserva o texto original', async () => {
    const { store, library } = ctx
    await doneItem(store, '/v/reuniao.mp4', ['Bom dia. Reunião de equipe hoje.'])
    const hits = await library.search('REUNIAO')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ title: 'reuniao.mp4', start: 0, end: 1 })
    expect(hits[0]?.snippet).toBe('Bom dia. Reunião de equipe hoje.')
  })

  it('snippet corta com … nas duas bordas', async () => {
    const { store, library } = ctx
    await doneItem(store, '/v/longo.mp4', [`${'a'.repeat(200)} agulha ${'b'.repeat(200)}`])
    const snippet = (await library.search('agulha'))[0]?.snippet ?? ''
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('agulha')
  })

  it('snippet nas bordas do texto não repete o … do lado sem corte', async () => {
    const { store, library } = ctx
    await doneItem(store, '/v/inicio.mp4', [`agulha ${'b'.repeat(200)}`])
    await doneItem(store, '/v/fim.mp4', [`${'a'.repeat(200)} agulha`])
    const atStart = (await library.search('agulha'))[1]?.snippet ?? ''
    const atEnd = (await library.search('agulha'))[0]?.snippet ?? ''
    expect(atStart.startsWith('…')).toBe(false)
    expect(atStart.endsWith('…')).toBe(true)
    expect(atEnd.startsWith('…')).toBe(true)
    expect(atEnd.endsWith('…')).toBe(false)
  })

  it('respeita o limite e ignora itens sem ocorrência', async () => {
    const { store, library } = ctx
    await doneItem(store, '/v/com.mp4', ['alvo um', 'alvo dois', 'alvo tres'])
    await doneItem(store, '/v/sem.mp4', ['nada aqui'])
    expect(await library.search('alvo')).toHaveLength(3)
    expect(await library.search('alvo', 2)).toHaveLength(2)
  })

  it('ordena por item mais novo e, dentro do item, por tempo', async () => {
    const { store, library } = ctx
    const older = await doneItem(store, '/v/velho.mp4', ['alvo velho'])
    const newer = await doneItem(store, '/v/novo.mp4', ['alvo novo'])
    const byItem = await library.search('alvo')
    expect(byItem.map((hit) => hit.id)).toEqual([newer.id, older.id])

    const fora = await store.create({ ...JOB, sourcePath: '/v/ordem.mp4' })
    await writeEntries(store, fora.id, [
      { inicio: 20, fim: 21, texto: 'alvo terceiro' },
      { inicio: 0, fim: 1, texto: 'alvo primeiro' },
      { inicio: 10, fim: 11, texto: 'alvo segundo' }
    ])
    await store.update(fora.id, { status: 'done' })
    const dentro = (await library.search('alvo')).filter((hit) => hit.id === fora.id)
    expect(dentro.map((hit) => hit.start)).toEqual([0, 10, 20])
  })

  it('busca na versão ativa, inclusive parcial, e traz o falante', async () => {
    const { store, library } = ctx
    const meta = await liveItem(store, 'Ao vivo', [
      { start: 0, end: 1, text: 'Combinado revisar o contrato', speaker: 'voce' }
    ])
    const hits = await library.search('contrato')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      id: meta.id,
      start: 0,
      end: 1,
      speaker: 'voce',
      createdAt: meta.createdAt
    })
  })

  it('query vazia não devolve nada', async () => {
    expect(await ctx.library.search('')).toEqual([])
  })
})

describe('TranscriptLibrary.read', () => {
  it('pagina transcrição de 250 mil caracteres e a concatenação é o todo', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/grande.mp4' })
    const entries: TranscriptEntry[] = Array.from({ length: 600 }, (_, index) => ({
      inicio: index * 10,
      fim: index * 10 + 1,
      texto: `Trecho ${index} ${'x'.repeat(480)}`
    }))
    await writeEntries(store, meta.id, entries)
    await store.update(meta.id, { status: 'done', duration: 6000 })

    const expected = paragraphsToText(toParagraphs(entries), LABELS)
    let content = ''
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await library.read(
        meta.id,
        cursor === null ? { format: 'text' } : { format: 'text', cursor }
      )
      content += page.content
      cursor = page.nextCursor
      pages++
    } while (cursor !== null && pages < 30)
    expect(pages).toBeGreaterThanOrEqual(6)
    expect(content).toBe(expected)
  })

  it('cursor inválido, de outro parâmetro ou fora do intervalo → INVALID_REQUEST', async () => {
    const { store, library } = ctx
    const meta = await doneItem(
      store,
      '/v/cursor.mp4',
      Array.from({ length: 300 }, (_, index) => `t${index} ${'y'.repeat(500)}`)
    )
    await expect(library.read(meta.id, { format: 'text', cursor: '###' })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    const badShape = Buffer.from(JSON.stringify({ i: -1 }), 'utf8').toString('base64url')
    await expect(library.read(meta.id, { format: 'text', cursor: badShape })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )

    const first = await library.read(meta.id, { format: 'text' })
    expect(first.nextCursor).not.toBeNull()
    const cursor = first.nextCursor ?? ''
    await expect(library.read(meta.id, { format: 'timestamped', cursor })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    await expect(library.read(meta.id, { format: 'text', fromS: 0, cursor })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    const far = Buffer.from(JSON.stringify({ i: 9999, f: 'text', v: 'active' }), 'utf8').toString(
      'base64url'
    )
    await expect(library.read(meta.id, { format: 'text', cursor: far })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
  })

  it('from_s/to_s mantém trechos que se sobrepõem', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/range.mp4')
    await writeEntries(store, meta.id, [
      { inicio: 0, fim: 1, texto: 'um' },
      { inicio: 10, fim: 11, texto: 'dois' },
      { inicio: 20, fim: 21, texto: 'tres' }
    ])
    const result = await library.read(meta.id, { format: 'text', fromS: 10, toS: 20 })
    expect(result.content).toContain('dois')
    expect(result.content).toContain('tres')
    expect(result.content).not.toContain('um')
    expect(result.range).toEqual({ fromS: 10, toS: 21 })

    await expect(library.read(meta.id, { fromS: 5, toS: 1 })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    await expect(library.read(meta.id, { fromS: -1 })).rejects.toSatisfy(isCode('INVALID_REQUEST'))
  })

  it('pagina dentro de um intervalo e o cursor carrega o recorte', async () => {
    const { store, library } = ctx
    const meta = await doneItem(
      store,
      '/v/intervalo.mp4',
      Array.from({ length: 300 }, (_, index) => `Trecho ${index} ${'z'.repeat(500)}`)
    )
    const first = await library.read(meta.id, { format: 'text', fromS: 100, toS: 2500 })
    expect(first.nextCursor).not.toBeNull()
    const cursor = first.nextCursor ?? ''
    const second = await library.read(meta.id, {
      format: 'text',
      fromS: 100,
      toS: 2500,
      cursor
    })
    expect(second.content.length).toBeGreaterThan(0)
    await expect(
      library.read(meta.id, { format: 'text', fromS: 200, toS: 2500, cursor })
    ).rejects.toSatisfy(isCode('INVALID_REQUEST'))
  })

  it('versões live e redo; redo inexistente → NOT_FOUND; versão em arquivo → INVALID_REQUEST', async () => {
    const { store, library } = ctx
    const live = await liveItem(store, 'R', [
      { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' }
    ])
    const liveRead = await library.read(live.id, { version: 'live' })
    expect(liveRead.content).toContain('Você: ao vivo')
    expect(liveRead.inProgress).toBe(true)
    await expect(library.read(live.id, { version: 'redo' })).rejects.toSatisfy(isCode('NOT_FOUND'))

    const file = await doneItem(store, '/v/f.mp4')
    await expect(library.read(file.id, { version: 'live' })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    await expect(library.read(file.id, { version: 'redo' })).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
  })

  it('versão redo e ativa depois de finalizar', async () => {
    const { store, library } = ctx
    const live = await liveItem(store, 'R', [
      { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' }
    ])
    await store.finalizeLive(live.id)
    await store.appendSegment(live.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(live.id)
    await store.update(live.id, { status: 'done' })
    expect((await library.read(live.id, { version: 'redo' })).content).toContain('refeita')
    expect((await library.read(live.id)).content).toContain('ao vivo')
  })

  it('versão live finalizada e versão ativa refeita não ficam inProgress', async () => {
    const { store, library } = ctx
    const live = await liveItem(store, 'R', [
      { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' }
    ])
    await store.finalizeLive(live.id)
    await store.appendSegment(live.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(live.id)
    await store.update(live.id, { status: 'done', activeVersion: 'redo' })
    expect((await library.read(live.id, { version: 'live' })).inProgress).toBe(false)
    const active = await library.read(live.id)
    expect(active.content).toContain('refeita')
    expect(active.inProgress).toBe(false)
  })

  it('item só com parcial (última linha truncada) devolve trechos e inProgress', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/parcial.mp4' })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'primeiro' })
    await store.appendSegment(meta.id, { start: 1, end: 2, text: 'segundo' })
    await appendFile(store.paths(meta.id).partial, '{"start":2, "en')
    const result = await library.read(meta.id)
    expect(result.inProgress).toBe(true)
    expect(result.totalSegments).toBe(2)
    expect(result.content).toContain('primeiro')
    expect(result.content).toContain('segundo')
    expect(result.nextCursor).toBeNull()
  })

  it('item interrompido sem transcrição fica inProgress', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/interrompido.mp4' })
    await store.update(meta.id, { status: 'interrupted' })
    expect((await library.read(meta.id)).inProgress).toBe(true)
  })

  it('timestamped e json rotulam o falante', async () => {
    const { store, library } = ctx
    const meta = await liveItem(store, 'R', [
      { start: 0, end: 1, text: 'Oi', speaker: 'voce' },
      { start: 2, end: 3, text: 'Olá', speaker: 'outros' }
    ])
    const timestamped = await library.read(meta.id, { format: 'timestamped' })
    expect(timestamped.content).toBe('[00:00 - 00:01] Você: Oi\n[00:02 - 00:03] Outros: Olá\n')
    const json = await library.read(meta.id, { format: 'json' })
    expect(JSON.parse(json.content)).toEqual([
      { inicio: 0, fim: 1, texto: 'Oi', falante: 'voce' },
      { inicio: 2, fim: 3, texto: 'Olá', falante: 'outros' }
    ])
  })

  it('transcrição vazia devolve conteúdo vazio e meta do item', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/vazio.mp4' })
    await store.finalize(meta.id)
    await store.update(meta.id, { status: 'done' })
    const result = await library.read(meta.id)
    expect(result.content).toBe('')
    expect(result.nextCursor).toBeNull()
    expect(result.inProgress).toBe(false)
    expect(result.range).toEqual({ fromS: null, toS: null })
    expect(result.meta).toMatchObject({
      id: meta.id,
      title: 'vazio.mp4',
      status: 'done',
      kind: 'file',
      hasRedo: false
    })
  })
})

describe('TranscriptLibrary.segmentsAfter', () => {
  it('não repete nem pula enquanto o parcial cresce', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/s.mp4' })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'um' })
    const first = await library.segmentsAfter(meta.id, 0)
    expect(first.segments.map((s) => s.texto)).toEqual(['um'])
    expect(first.next).toBe(1)
    await store.appendSegment(meta.id, { start: 1, end: 2, text: 'dois' })
    const second = await library.segmentsAfter(meta.id, first.next)
    expect(second.segments.map((s) => s.texto)).toEqual(['dois'])
    expect(second.next).toBe(2)
  })

  it('after negativo vira 0', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/neg.mp4' })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'um' })
    const result = await library.segmentsAfter(meta.id, -5)
    expect(result.segments.map((s) => s.texto)).toEqual(['um'])
  })

  it('depois de finalizar o índice continua coerente', async () => {
    const { store, library } = ctx
    const meta = await store.create({ ...JOB, sourcePath: '/v/s2.mp4' })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'um' })
    await store.appendSegment(meta.id, { start: 1, end: 2, text: 'dois' })
    const growing = await library.segmentsAfter(meta.id, 0)
    expect(growing.next).toBe(2)
    await store.finalize(meta.id)
    await store.update(meta.id, { status: 'done' })
    const done = await library.segmentsAfter(meta.id, growing.next)
    expect(done.segments).toEqual([])
    expect(done.next).toBe(2)
    expect((await library.segmentsAfter(meta.id, 0)).segments.map((s) => s.texto)).toEqual([
      'um',
      'dois'
    ])
  })
})

describe('TranscriptLibrary.audio', () => {
  it('mix devolve caminho, mime, bytes e duração', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/a.mp4')
    await writeFile(store.paths(meta.id).audio, Buffer.from('abcd'))
    expect(await library.audio(meta.id, 'mix')).toEqual({
      path: store.paths(meta.id).audio,
      mime: 'audio/mp4',
      bytes: 4,
      durationS: 5
    })
  })

  it('mix ainda não gerado → NOT_FOUND', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/a.mp4')
    await expect(library.audio(meta.id, 'mix')).rejects.toSatisfy(isCode('NOT_FOUND'))
  })

  it('voce/outros só ao vivo; faixa ao vivo resolve', async () => {
    const { store, library } = ctx
    const file = await doneItem(store, '/v/a.mp4')
    await expect(library.audio(file.id, 'voce')).rejects.toSatisfy(isCode('INVALID_REQUEST'))
    const live = await liveItem(store, 'R')
    await writeFile(join(store.paths(live.id).dir, 'voce.m4a'), Buffer.from('xy'))
    expect(await library.audio(live.id, 'voce')).toMatchObject({ mime: 'audio/mp4', bytes: 2 })
    await expect(library.audio(live.id, 'outros')).rejects.toSatisfy(isCode('NOT_FOUND'))
  })

  it('source só em arquivo e precisa existir', async () => {
    const { store, library } = ctx
    const dir = await makeTempDir()
    const source = join(dir, 'origem.mp3')
    await writeFile(source, Buffer.from('abc'))
    const meta = await store.create({ ...JOB, sourcePath: source, mediaKind: 'audio' })
    expect(await library.audio(meta.id, 'source')).toMatchObject({
      path: source,
      mime: 'audio/mpeg',
      bytes: 3
    })
    await rm(source, { force: true })
    await expect(library.audio(meta.id, 'source')).rejects.toSatisfy(isCode('FILE_NOT_FOUND'))
    const live = await liveItem(store, 'R')
    await expect(library.audio(live.id, 'source')).rejects.toSatisfy(isCode('INVALID_REQUEST'))
  })

  it('id não-UUID → INVALID_REQUEST', async () => {
    await expect(ctx.library.audio('../../etc', 'mix')).rejects.toSatisfy(isCode('INVALID_REQUEST'))
  })

  it.skipIf(process.platform === 'win32')('recusa symlink para fora de history/<id>/', async () => {
    const { store, library } = ctx
    const outside = join(await makeTempDir(), 'fora.m4a')
    await writeFile(outside, Buffer.from('x'))
    const live = await liveItem(store, 'R')
    await symlink(outside, join(store.paths(live.id).dir, 'voce.m4a'))
    await expect(library.audio(live.id, 'voce')).rejects.toSatisfy(isCode('FILE_NOT_FOUND'))
  })
})

describe('TranscriptLibrary.export', () => {
  it('grava txt com o nome do título, sem sobrescrever', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/Minha reunião.mp4', ['Bom dia.', 'Boa tarde.'])
    const dir = await makeTempDir()
    const path = await library.export(meta.id, 'txt', dir)
    expect(path).toBe(join(dir, 'Minha reunião.txt'))
    expect(await readFile(path, 'utf8')).toBe(
      paragraphsToText(toParagraphs(entriesOf('Bom dia.', 'Boa tarde.')), LABELS)
    )

    await writeFile(join(dir, 'Minha reunião.txt'), 'antigo')
    const second = await library.export(meta.id, 'txt', dir)
    expect(second).toBe(join(dir, 'Minha reunião (2).txt'))
    expect(await readFile(join(dir, 'Minha reunião.txt'), 'utf8')).toBe('antigo')
  })

  it('timestamped leva sufixo (tempos) e json exporta a lista', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/a.mp4', ['Oi'])
    const dir = await makeTempDir()
    const timestamped = await library.export(meta.id, 'timestamped', dir)
    expect(timestamped).toBe(join(dir, 'a (tempos).txt'))
    expect(await readFile(timestamped, 'utf8')).toBe('[00:00 - 00:01] Oi\n')
    const json = await library.export(meta.id, 'json', dir)
    expect(json).toBe(join(dir, 'a.json'))
    expect(JSON.parse(await readFile(json, 'utf8'))).toEqual([{ inicio: 0, fim: 1, texto: 'Oi' }])
  })

  it('sanitiza / e : no título e cobre título vazio', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/a.mp4')
    const dir = await makeTempDir()
    await store.update(meta.id, { fileName: 'Reunião / planilha: vendas' })
    const path = await library.export(meta.id, 'txt', dir)
    expect(path).toBe(join(dir, 'Reunião _ planilha_ vendas.txt'))
    expect(path).not.toContain('/planilha')

    await store.update(meta.id, { fileName: '   ' })
    expect(await library.export(meta.id, 'json', dir)).toBe(join(dir, 'transcricao.json'))
  })

  it('pasta relativa, inexistente ou que é arquivo → INVALID_REQUEST', async () => {
    const { store, library } = ctx
    const meta = await doneItem(store, '/v/a.mp4')
    await expect(library.export(meta.id, 'txt', 'relativa')).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    await expect(library.export(meta.id, 'txt', join(ctx.root, 'nao-existe'))).rejects.toSatisfy(
      isCode('INVALID_REQUEST')
    )
    const file = join(await makeTempDir(), 'arquivo')
    await writeFile(file, 'x')
    await expect(library.export(meta.id, 'txt', file)).rejects.toSatisfy(isCode('INVALID_REQUEST'))
  })

  it('exporta a versão live e a refeita', async () => {
    const { store, library } = ctx
    const live = await liveItem(store, 'R', [
      { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' }
    ])
    await store.finalizeLive(live.id)
    await store.appendSegment(live.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(live.id)
    const dir = await makeTempDir()
    expect(await readFile(await library.export(live.id, 'txt', dir, 'live'), 'utf8')).toContain(
      'ao vivo'
    )
    expect(await readFile(await library.export(live.id, 'txt', dir, 'redo'), 'utf8')).toContain(
      'refeita'
    )
  })
})
