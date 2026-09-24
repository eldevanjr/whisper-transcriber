import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryStore } from '../../src/main/history/store'
import { contentTypeFor, createMediaHandler, parseRange } from '../../src/main/media-protocol'
import { makeTempDir } from '../helpers/tmp'

const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i))

async function setup(kind: 'video' | 'audio' = 'video') {
  const dir = await makeTempDir()
  const history = new HistoryStore(join(dir, 'history'))
  const source = join(dir, kind === 'video' ? 'aula.mp4' : 'voz.mp3')
  await writeFile(source, BYTES)
  const meta = await history.create({
    sourcePath: source,
    mediaKind: kind,
    model: 'medium',
    language: 'pt'
  })
  await writeFile(history.paths(meta.id).audio, Buffer.from('audio'))
  return { handler: createMediaHandler({ history }), history, meta, source }
}

const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe('parseRange', () => {
  it.each([
    [null, null],
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=90-', { start: 90, end: 99 }],
    ['bytes=90-500', { start: 90, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=-500', { start: 0, end: 99 }],
    ['bytes=100-', 'invalid'],
    ['bytes=9-3', 'invalid'],
    ['bytes=-0', 'invalid'],
    ['bytes=-', 'invalid'],
    ['items=0-1', 'invalid']
  ])('parseRange(%s, 100) = %j', (header, expected) => {
    expect(parseRange(header, 100)).toEqual(expected)
  })
})

describe('contentTypeFor', () => {
  it.each([
    ['a.MP4', 'video/mp4'],
    ['a.webm', 'video/webm'],
    ['a.m4a', 'audio/mp4'],
    ['a.mp3', 'audio/mpeg'],
    ['a.xyz', 'application/octet-stream']
  ])('%s → %s', (path, type) => {
    expect(contentTypeFor(path)).toBe(type)
  })
})

describe('createMediaHandler', () => {
  it('serve o vídeo original inteiro', async () => {
    const { handler, meta } = await setup()
    const response = await handler(get(`app-media://${meta.id}/video`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('100')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES)
  })

  it('atende Range com 206', async () => {
    const { handler, meta } = await setup()
    const response = await handler(get(`app-media://${meta.id}/video`, { Range: 'bytes=10-19' }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES.subarray(10, 20))
  })

  it('Range inválido → 416', async () => {
    const { handler, meta } = await setup()
    const response = await handler(get(`app-media://${meta.id}/video`, { Range: 'bytes=500-' }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */100')
  })

  it('vídeo movido cai para o áudio salvo com aviso', async () => {
    const { handler, meta, source } = await setup()
    await rm(source)
    const response = await handler(get(`app-media://${meta.id}/video`))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-media-fallback')).toBe('1')
    expect(await response.text()).toBe('audio')
  })

  it('faixas do ao vivo: /voce e /outros entregam cada lado', async () => {
    const { handler, history, meta } = await setup()
    const { dir } = history.paths(meta.id)
    await writeFile(join(dir, 'voce.m4a'), Buffer.from('voce'))
    const response = await handler(get(`app-media://${meta.id}/voce`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/mp4')
    expect(await response.text()).toBe('voce')
    expect((await handler(get(`app-media://${meta.id}/outros`))).status).toBe(404) // não gravada
  })

  it('item de áudio: /video também entrega o áudio salvo', async () => {
    const { handler, meta } = await setup('audio')
    const response = await handler(get(`app-media://${meta.id}/video`))
    expect(response.headers.get('content-type')).toBe('audio/mp4')
  })

  it('/audio entrega o áudio salvo', async () => {
    const { handler, meta } = await setup()
    expect(await (await handler(get(`app-media://${meta.id}/audio`))).text()).toBe('audio')
  })

  it('nenhuma resposta vai para o cache (o áudio passa a existir no meio do job)', async () => {
    const { handler, meta } = await setup()
    const ok = await handler(get(`app-media://${meta.id}/audio`))
    const missing = await handler(get('app-media://11111111-1111-4111-8111-111111111111/audio'))
    expect(ok.headers.get('Cache-Control')).toBe('no-store')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Cache-Control')).toBe('no-store')
  })

  it('arquivo vazio responde 200 sem corpo', async () => {
    const { handler, meta } = await setup('audio')
    const dir = join(meta.sourcePath, '..')
    await writeFile(join(dir, 'history', meta.id, 'audio.m4a'), '')
    const response = await handler(get(`app-media://${meta.id}/audio`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it.each([
    'app-media://nao-e-uuid/video',
    'app-media://11111111-1111-4111-8111-111111111111/video',
    'app-media://11111111-1111-4111-8111-111111111111/../../etc/passwd',
    'app-media://11111111-1111-4111-8111-111111111111/outra-coisa'
  ])('%s → 404', async (url) => {
    const { handler } = await setup()
    expect((await handler(get(url))).status).toBe(404)
  })
})
