import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { pathExists } from '../../../src/main/fs-utils'
import { AppError } from '../../../src/shared/errors'
import { makeTempDir } from '../../helpers/tmp'

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]

async function makeStore() {
  const root = join(await makeTempDir(), 'history')
  let tick = 0
  const ids = [...IDS]
  const store = new HistoryStore(
    root,
    () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++)),
    () => ids.shift()!
  )
  return { root, store }
}

const job = {
  sourcePath: 'C:\\Users\\João\\aula 03.mp4',
  mediaKind: 'video' as const,
  model: 'medium' as const,
  language: 'pt'
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('HistoryStore', () => {
  it('create grava meta.json com status queued', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    expect(meta).toEqual({
      id: IDS[0],
      fileName: 'aula 03.mp4',
      sourcePath: job.sourcePath,
      mediaKind: 'video',
      createdAt: '2026-09-23T10:00:00.000Z',
      status: 'queued',
      model: 'medium',
      language: 'pt',
      languageDetected: null,
      duration: null,
      error: null,
      kind: 'file'
    })
    expect(await store.get(meta.id)).toEqual(meta)
  })

  it('update altera só os campos do patch', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    const next = await store.update(meta.id, { status: 'done', duration: 12.5 })
    expect(next).toEqual({ ...meta, status: 'done', duration: 12.5 })
  })

  it('rejeita ids que não são UUID (path traversal) antes de tocar o disco', async () => {
    const { store } = await makeStore()
    for (const id of ['../../etc', '..\\..\\Windows', '']) {
      expect(() => store.paths(id)).toThrow(AppError)
      await expect(store.get(id)).rejects.toSatisfy(isCode('INVALID_REQUEST'))
    }
  })

  it('get: inexistente → NOT_FOUND; corrompido → INTERNAL', async () => {
    const { root, store } = await makeStore()
    await expect(store.get(IDS[0]!)).rejects.toSatisfy(isCode('NOT_FOUND'))
    await mkdir(join(root, IDS[1]!), { recursive: true })
    await writeFile(join(root, IDS[1]!, 'meta.json'), '{"id":"x"}')
    await expect(store.get(IDS[1]!)).rejects.toSatisfy(isCode('INTERNAL'))
    await writeFile(join(root, IDS[1]!, 'meta.json'), '{ quebrado')
    await expect(store.get(IDS[1]!)).rejects.toSatisfy(isCode('INTERNAL'))
  })

  it('list: mais novos primeiro, corrompidos separados, ignora pastas estranhas', async () => {
    const { root, store } = await makeStore()
    const a = await store.create(job)
    const b = await store.create(job)
    await mkdir(join(root, IDS[2]!))
    await mkdir(join(root, 'lixo'))
    const list = await store.list()
    expect(list.entries.map((e) => e.id)).toEqual([b.id, a.id])
    expect(list.corrupted).toEqual([IDS[2]])
  })

  it('list sem pasta de histórico devolve vazio', async () => {
    const { store } = await makeStore()
    expect(await store.list()).toEqual({ entries: [], corrupted: [] })
  })

  it('finalize converte o parcial para o formato atual e ignora linha cortada', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    await store.appendSegment(meta.id, { start: 0, end: 1.23456, text: 'Bom dia' })
    await store.appendSegment(meta.id, { start: 1.23456, end: 3, text: 'pessoal' })
    await appendFile(store.paths(meta.id).partial, '{"start": 3, "en') // app fechou no meio da escrita
    const entries = await store.finalize(meta.id)
    expect(entries).toEqual([
      { inicio: 0, fim: 1.235, texto: 'Bom dia' },
      { inicio: 1.235, fim: 3, texto: 'pessoal' }
    ])
    expect(await store.readTranscript(meta.id)).toEqual(entries)
    expect(await pathExists(store.paths(meta.id).partial)).toBe(false)
  })

  it('finalize sem segmentos gera transcrição vazia', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    expect(await store.finalize(meta.id)).toEqual([])
  })

  it('readTranscript: ausente → []; corrompida → INTERNAL', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    expect(await store.readTranscript(meta.id)).toEqual([])
    await writeFile(store.paths(meta.id).transcript, '[{"inicio":"x"}]')
    await expect(store.readTranscript(meta.id)).rejects.toSatisfy(isCode('INTERNAL'))
    await writeFile(store.paths(meta.id).transcript, '[{ quebrado')
    await expect(store.readTranscript(meta.id)).rejects.toSatisfy(isCode('INTERNAL'))
  })

  it('readTranscript sem transcript.json devolve os trechos do parcial (job em andamento ou interrompido)', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    await store.appendSegment(meta.id, { start: 0, end: 1.23456, text: 'Olá' })
    expect(await store.readTranscript(meta.id)).toEqual([{ inicio: 0, fim: 1.235, texto: 'Olá' }])
  })

  it('usa relógio e ids reais por padrão', async () => {
    const store = new HistoryStore(join(await makeTempDir(), 'history'))
    const meta = await store.create(job)
    expect(Date.parse(meta.createdAt)).toBeLessThanOrEqual(Date.now())
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('discardOutputs apaga parcial e áudio, mantendo o meta', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    const p = store.paths(meta.id)
    await writeFile(p.partial, 'x')
    await writeFile(p.audio, 'x')
    await store.discardOutputs(meta.id)
    expect(await pathExists(p.partial)).toBe(false)
    expect(await pathExists(p.audio)).toBe(false)
    expect(await pathExists(p.meta)).toBe(true)
  })

  it('discardPartial apaga só o parcial: o áudio extraído fica para reaproveitar', async () => {
    const { store } = await makeStore()
    const meta = await store.create(job)
    const p = store.paths(meta.id)
    await writeFile(p.partial, 'x')
    await writeFile(p.audio, 'x')
    await store.discardPartial(meta.id)
    expect(await pathExists(p.partial)).toBe(false)
    expect(await pathExists(p.audio)).toBe(true)
  })

  it('remove, stats e clear', async () => {
    const { root, store } = await makeStore()
    const a = await store.create(job)
    await store.create(job)
    await writeFile(store.paths(a.id).audio, '12345')
    const stats = await store.stats()
    expect(stats.count).toBe(2)
    expect(stats.bytes).toBeGreaterThan(5)
    await store.remove(a.id)
    expect((await store.stats()).count).toBe(1)
    const cleared = await store.clear()
    expect(cleared.count).toBe(1)
    expect(await store.list()).toEqual({ entries: [], corrupted: [] })
    expect(await pathExists(root)).toBe(true)
  })
})

describe('HistoryStore — ao vivo', () => {
  it('createLive cria o item ao vivo em processamento, com as faixas e a versão ao vivo', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'Reunião 23/09 10:00',
      tracks: ['voce', 'outros'],
      model: 'medium',
      language: null
    })
    expect(meta).toMatchObject({
      kind: 'live',
      fileName: 'Reunião 23/09 10:00',
      sourcePath: '',
      mediaKind: 'audio',
      status: 'processing',
      tracks: ['voce', 'outros'],
      activeVersion: 'live'
    })
    expect(await pathExists(store.paths(meta.id).dir)).toBe(true)
    expect(await store.get(meta.id)).toEqual(meta)
  })

  it('finalizeLive grava só a versão ao vivo (transcript.json fica para a refeita)', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: 'pt'
    })
    await store.appendSegment(meta.id, { start: 0, end: 1.5, text: 'Oi.', speaker: 'voce' })
    await store.appendSegment(meta.id, { start: 2, end: 3, text: 'Tudo bem?', speaker: 'outros' })
    const entries = await store.finalizeLive(meta.id)
    expect(entries).toEqual([
      { inicio: 0, fim: 1.5, texto: 'Oi.', falante: 'voce' },
      { inicio: 2, fim: 3, texto: 'Tudo bem?', falante: 'outros' }
    ])
    const { transcript, live, partial } = store.paths(meta.id)
    expect(JSON.parse(await readFile(live, 'utf8'))).toEqual(entries)
    expect(await pathExists(transcript)).toBe(false)
    expect(await pathExists(partial)).toBe(false)
  })

  it('finalize intercala por início os trechos das duas faixas (refazer do ao vivo)', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce', 'outros'],
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'A', speaker: 'voce' })
    await store.appendSegment(meta.id, { start: 4, end: 5, text: 'C', speaker: 'voce' })
    await store.appendSegment(meta.id, { start: 2, end: 3, text: 'B', speaker: 'outros' })
    expect((await store.finalize(meta.id)).map((e) => e.texto)).toEqual(['A', 'B', 'C'])
  })

  it('versão ativa: ao vivo até existir a refeita; a escolha decide o que aparece', async () => {
    const { store } = await makeStore()
    let meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await store.finalizeLive(meta.id)
    expect(await store.hasRedo(meta)).toBe(false)
    expect((await store.readActive(meta)).map((e) => e.texto)).toEqual(['ao vivo'])
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(meta.id)
    meta = await store.update(meta.id, { activeVersion: 'redo' })
    expect(await store.hasRedo(meta)).toBe(true)
    expect((await store.readActive(meta)).map((e) => e.texto)).toEqual(['refeita'])
    meta = await store.update(meta.id, { activeVersion: 'live' })
    expect((await store.readActive(meta)).map((e) => e.texto)).toEqual(['ao vivo'])
  })

  it('readVersion: live é a ao vivo/parcial; redo sem refeita → NOT_FOUND', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    expect(await store.readVersion(meta, 'live')).toEqual([
      { inicio: 0, fim: 1, texto: 'ao vivo', falante: 'voce' }
    ])
    await expect(store.readVersion(meta, 'redo')).rejects.toSatisfy(isCode('NOT_FOUND'))
  })

  it('readVersion redo devolve a refeita depois de finalizada', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await store.finalizeLive(meta.id)
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'refeita', speaker: 'voce' })
    await store.finalize(meta.id)
    expect(await store.readVersion(meta, 'redo')).toEqual([
      { inicio: 0, fim: 1, texto: 'refeita', falante: 'voce' }
    ])
  })

  it('arquivo comum: readActive é a transcrição de sempre e não há refeita', async () => {
    const { store } = await makeStore()
    const meta = await store.create({
      sourcePath: '/v/a.mp4',
      mediaKind: 'video',
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'oi' })
    await store.finalize(meta.id)
    expect((await store.readActive(meta)).map((e) => e.texto)).toEqual(['oi'])
    expect(await store.hasRedo(meta)).toBe(false)
  })

  it('durante a sessão ao vivo, readActive mostra os trechos do parcial', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: null
    })
    await store.appendSegment(meta.id, { start: 0, end: 1, text: 'falando', speaker: 'voce' })
    expect(await store.readActive(meta)).toEqual([
      { inicio: 0, fim: 1, texto: 'falando', falante: 'voce' }
    ])
  })

  it('versão ao vivo corrompida vira erro claro', async () => {
    const { store } = await makeStore()
    const meta = await store.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'small',
      language: null
    })
    await writeFile(store.paths(meta.id).live, '{quebrado', 'utf8')
    await expect(store.readActive(meta)).rejects.toMatchObject({ code: 'INTERNAL' })
  })
})
