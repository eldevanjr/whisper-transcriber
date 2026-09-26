import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { LiveService, type LiveDeps } from '../../../src/main/live/session'
import type { LiveWorkerEvent, WorkerCommand } from '../../../src/main/worker/protocol'
import { AppError } from '../../../src/shared/errors'
import type { LiveEvent } from '../../../src/shared/events'
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

const BLOCK_48K = 4800

async function setup(overrides: Partial<LiveDeps> = {}, settings: Partial<Settings> = {}) {
  const dir = await makeTempDir()
  const history = new HistoryStore(join(dir, 'history'), () => new Date(Date.UTC(2026, 8, 23, 10)))
  const requests: WorkerCommand[] = []
  const notified: WorkerCommand[] = []
  const events: LiveEvent[] = []
  const worker = {
    request: vi.fn((command: WorkerCommand) => {
      requests.push(command)
      if (command.cmd === 'live_finalize') return Promise.resolve({ durations: { voce: 12.5 } })
      return Promise.resolve({})
    }),
    notify: vi.fn((command: WorkerCommand) => {
      notified.push(command)
      return true
    })
  }
  const queue = {
    holdForLive: vi.fn(() => Promise.resolve()),
    releaseLive: vi.fn(),
    reloadLiveOnCpu: vi.fn(() => Promise.resolve())
  }
  const current: Settings = {
    ...DEFAULT_SETTINGS,
    model: 'medium',
    audioLanguage: 'auto',
    ...settings
  }
  const items = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new LiveService({
    worker,
    queue,
    history,
    settings: { get: () => current },
    emit: (event) => events.push(event),
    onItem: items,
    logger,
    ...overrides
  })
  return {
    service,
    history,
    worker,
    queue,
    requests,
    notified,
    events,
    items,
    logger,
    sessionId: ''
  }
}

const block = (value = 1000) => new Int16Array(BLOCK_48K).fill(value)
const segmentEvent = (sessionId: string, text: string): LiveWorkerEvent => ({
  type: 'live_segment',
  session_id: sessionId,
  track: 'voce',
  start: 1,
  end: 2,
  text
})

describe('LiveService', () => {
  it('modo teste: sem item nem gravação; blocos vão reduzidos a 16 kHz para o worker', async () => {
    const ctx = await setup()
    const { sessionId, itemId } = await ctx.service.start({
      tracks: ['voce'],
      test: true,
      title: 'T'
    })
    expect(itemId).toBeNull()
    expect(ctx.requests[0]).toMatchObject({
      cmd: 'live_start',
      params: { session_id: sessionId, tracks: ['voce'], language: null, pause_s: 1, test: true }
    })
    ctx.service.audio('voce', 0, block())
    const sent = ctx.notified[0]
    expect(sent).toMatchObject({ cmd: 'live_audio', params: { track: 'voce', seq: 0 } })
    const pcm = Buffer.from(
      (sent as Extract<WorkerCommand, { cmd: 'live_audio' }>).params.pcm16_b64,
      'base64'
    )
    expect(pcm.length).toBe(1600 * 2)
    expect(await ctx.service.stop()).toBeNull()
    expect(ctx.requests.map((r) => r.cmd)).toEqual(['live_start', 'live_stop'])
    expect(ctx.queue.releaseLive).toHaveBeenCalled()
    expect(ctx.items).not.toHaveBeenCalled()
  })

  it('sessão real: item no histórico, WAV por faixa, trechos gravados e item concluído', async () => {
    const ctx = await setup()
    const { sessionId, itemId } = await ctx.service.start({
      tracks: ['voce'],
      test: false,
      title: 'Reunião 23/09 10:00'
    })
    expect(ctx.items).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'live', status: 'processing' })
    )
    ctx.service.audio('voce', 0, block(500))
    ctx.service.audio('voce', 1, block(500))
    ctx.service.onWorkerEvent(segmentEvent(sessionId, 'Bom dia.'))
    const meta = await ctx.service.stop()
    expect(ctx.requests.map((r) => r.cmd)).toEqual(['live_start', 'live_stop', 'live_finalize'])
    const paths = ctx.history.paths(itemId!)
    expect(ctx.requests[2]).toMatchObject({ params: { dir: paths.dir, tracks: ['voce'] } })
    expect(meta).toMatchObject({ status: 'done', duration: 12.5, activeVersion: 'live' })
    expect(JSON.parse(await readFile(paths.live, 'utf8'))).toEqual([
      { inicio: 1, fim: 2, texto: 'Bom dia.', falante: 'voce' }
    ])
    expect((await stat(join(paths.dir, 'live-voce.wav'))).size).toBe(44 + 2 * BLOCK_48K * 2)
    expect(ctx.events).toContainEqual({
      type: 'segment',
      track: 'voce',
      start: 1,
      end: 2,
      text: 'Bom dia.'
    })
    expect(ctx.events.at(-1)).toMatchObject({ type: 'state', state: 'idle' })
  })

  it('fila ocupada recusa e continua parado; segunda sessão ao mesmo tempo também', async () => {
    const busy = await setup({
      queue: {
        holdForLive: () => Promise.reject(new AppError('QUEUE_BUSY', 'x')),
        releaseLive: vi.fn(),
        reloadLiveOnCpu: vi.fn()
      }
    })
    await expect(
      busy.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'QUEUE_BUSY')
    expect(busy.service.state).toBe('idle')
    const ctx = await setup()
    await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    await expect(ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'LIVE_ACTIVE'
    )
    await ctx.service.stop()
  })

  it('pausa: blocos ignorados e a numeração para o worker continua sem buraco', async () => {
    const ctx = await setup()
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    Object.assign(ctx, { sessionId })
    ctx.service.audio('voce', 0, block())
    ctx.service.pause()
    ctx.service.audio('voce', 1, block())
    ctx.service.audio('voce', 2, block())
    ctx.service.resume()
    ctx.service.audio('voce', 3, block())
    const seqs = ctx.notified.map(
      (c) => (c as Extract<WorkerCommand, { cmd: 'live_audio' }>).params.seq
    )
    expect(seqs).toEqual([0, 1]) // o intervalo pausado não conta
    // a frase em andamento é fechada e transcrita na pausa
    expect(ctx.requests).toContainEqual({
      cmd: 'live_pause',
      params: { session_id: ctx.sessionId }
    })
    await ctx.service.stop()
  })

  it('dois stop() concorrentes compartilham a mesma finalização', async () => {
    const ctx = await setup()
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    const first = ctx.service.stop()
    const second = ctx.service.stop()
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(ctx.requests.filter((r) => r.cmd === 'live_stop')).toHaveLength(1)
    expect(ctx.requests.filter((r) => r.cmd === 'live_finalize')).toHaveLength(1)
    expect(ctx.queue.releaseLive).toHaveBeenCalledTimes(1)
  })

  it('pausa com o worker fora do ar só registra no log', async () => {
    const ctx = await setup()
    await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    ctx.worker.request.mockRejectedValueOnce(new AppError('WORKER_CRASHED', 'caiu'))
    ctx.service.pause()
    await vi.waitFor(() => {
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_CRASHED'))
    })
    await ctx.service.stop()
  })

  it('bloco perdido na IPC: buraco repassado ao worker e silêncio no WAV', async () => {
    const ctx = await setup()
    const { itemId } = await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ctx.service.audio('voce', 0, block())
    ctx.service.audio('voce', 2, block()) // o 1 se perdeu
    const seqs = ctx.notified.map(
      (c) => (c as Extract<WorkerCommand, { cmd: 'live_audio' }>).params.seq
    )
    expect(seqs).toEqual([0, 2])
    await ctx.service.stop()
    const wav = join(ctx.history.paths(itemId!).dir, 'live-voce.wav')
    expect((await stat(wav)).size).toBe(44 + 3 * BLOCK_48K * 2)
  })

  it('falha de GPU no worker: recarrega na CPU e avisa; eventos de outra sessão são ignorados', async () => {
    const ctx = await setup()
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    ctx.service.onWorkerEvent(segmentEvent('outra', 'x'))
    ctx.service.onWorkerEvent({ type: 'live_error', session_id: sessionId, code: 'GPU_FAILED' })
    await vi.waitFor(() => {
      expect(ctx.queue.reloadLiveOnCpu).toHaveBeenCalled()
    })
    expect(ctx.events).toContainEqual({ type: 'error', code: 'GPU_FAILED' })
    expect(ctx.events.some((e) => e.type === 'segment')).toBe(false)
    ctx.service.onWorkerEvent({ type: 'live_lag', session_id: sessionId, seconds: 4 })
    ctx.service.onWorkerEvent({
      type: 'live_listening',
      session_id: sessionId,
      track: 'voce',
      active: true
    })
    expect(ctx.events).toContainEqual({ type: 'lag', seconds: 4 })
    expect(ctx.events).toContainEqual({ type: 'listening', track: 'voce', active: true })
    await ctx.service.stop()
  })

  it('disco cheio ao gravar: encerra salvando o que houve e avisa', async () => {
    const ctx = await setup({
      openWav: () =>
        Promise.resolve({
          samples: 0,
          append: () => Promise.reject(Object.assign(new Error('cheio'), { code: 'ENOSPC' })),
          close: () => Promise.resolve()
        })
    })
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ctx.service.audio('voce', 0, block())
    await vi.waitFor(() => {
      expect(ctx.service.state).toBe('idle')
    })
    expect(ctx.events).toContainEqual({ type: 'error', code: 'DISK_FULL' })
  })

  it('recuperação: sessão interrompida com WAV é finalizada e fica "Interrompida"', async () => {
    const ctx = await setup()
    const meta = await ctx.history.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'medium',
      language: null
    })
    await ctx.history.update(meta.id, { status: 'interrupted' })
    await writeFile(join(ctx.history.paths(meta.id).dir, 'live-voce.wav'), Buffer.alloc(44))
    await ctx.history.appendSegment(meta.id, { start: 0, end: 1, text: 'Oi.', speaker: 'voce' })
    await ctx.service.recover()
    expect(ctx.requests).toContainEqual({
      cmd: 'live_finalize',
      params: { dir: ctx.history.paths(meta.id).dir, tracks: ['voce'] }
    })
    expect(await ctx.history.get(meta.id)).toMatchObject({ status: 'interrupted', duration: 12.5 })
    expect(await ctx.history.readActive(await ctx.history.get(meta.id))).toEqual([
      { inicio: 0, fim: 1, texto: 'Oi.', falante: 'voce' }
    ])
  })
})

describe('LiveService — falhas', () => {
  it('worker recusa o início: item vira "falhou", fila liberada e parado', async () => {
    const ctx = await setup({
      worker: {
        request: (command: WorkerCommand) =>
          command.cmd === 'live_start'
            ? Promise.reject(new AppError('MODEL_NOT_LOADED', 'sem modelo'))
            : Promise.resolve({}),
        notify: () => true
      }
    })
    await expect(
      ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'MODEL_NOT_LOADED')
    expect(ctx.service.state).toBe('idle')
    expect(ctx.queue.releaseLive).toHaveBeenCalled()
    const [item] = (await ctx.history.list()).entries
    expect(item).toMatchObject({ status: 'failed', error: { code: 'MODEL_NOT_LOADED' } })
  })

  it('finalização falha: item vira "falhou" com o motivo', async () => {
    const ctx = await setup({
      worker: {
        request: (command: WorkerCommand) =>
          command.cmd === 'live_finalize'
            ? Promise.reject(new AppError('DISK_FULL', 'cheio'))
            : Promise.resolve({}),
        notify: () => true
      }
    })
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    expect(await ctx.service.stop()).toMatchObject({
      status: 'failed',
      error: { code: 'DISK_FULL' }
    })
  })

  it('worker caiu (live_stop falha): ainda fecha a gravação, finaliza o item e libera a fila', async () => {
    const ctx = await setup()
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ctx.worker.request.mockImplementation((command: WorkerCommand) => {
      ctx.requests.push(command)
      if (command.cmd === 'live_stop') return Promise.reject(new AppError('WORKER_CRASHED', 'caiu'))
      if (command.cmd === 'live_finalize') return Promise.resolve({ durations: { voce: 3 } })
      return Promise.resolve({})
    })
    expect(await ctx.service.stop()).toMatchObject({ status: 'done', duration: 3 })
    expect(ctx.service.state).toBe('idle')
    expect(ctx.queue.releaseLive).toHaveBeenCalled()
  })

  it('fechar o WAV ou gravar um trecho falhando não impede de finalizar', async () => {
    const close = vi.fn(() => Promise.reject(new Error('cheio')))
    const ctx = await setup({
      openWav: () => Promise.resolve({ samples: 0, append: () => Promise.resolve(), close })
    })
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    vi.spyOn(ctx.history, 'appendSegment').mockRejectedValueOnce(new Error('cheio'))
    ctx.service.onWorkerEvent(segmentEvent(sessionId, 'Oi'))
    expect(await ctx.service.stop()).toMatchObject({ status: 'done' })
    expect(close).toHaveBeenCalled()
    expect(ctx.logger.error).toHaveBeenCalled()
  })

  it('um trecho que não pôde ser gravado não impede os seguintes', async () => {
    const ctx = await setup()
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    vi.spyOn(ctx.history, 'appendSegment').mockRejectedValueOnce(new Error('cheio'))
    ctx.service.onWorkerEvent(segmentEvent(sessionId, 'perdido'))
    ctx.service.onWorkerEvent(segmentEvent(sessionId, 'salvo'))
    const meta = await ctx.service.stop()
    const entries = await ctx.history.readActive(meta!)
    expect(entries.map((e) => e.texto)).toEqual(['salvo'])
  })

  it('worker caiu no meio da sessão (bloco não enviado): avisa e encerra salvando', async () => {
    const ctx = await setup()
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ctx.worker.notify.mockReturnValue(false)
    ctx.service.audio('voce', 0, block())
    ctx.service.audio('voce', 1, block())
    await vi.waitFor(() => {
      expect(ctx.service.state).toBe('idle')
    })
    expect(ctx.events.filter((e) => e.type === 'error')).toEqual([
      { type: 'error', code: 'WORKER_CRASHED' }
    ])
    const [item] = (await ctx.history.list()).entries
    expect(item).toMatchObject({ status: 'done' })
  })

  it('recuperação: um item que falha vira "falhou" e os outros seguem', async () => {
    const ctx = await setup()
    const broken = await ctx.history.createLive({
      title: 'A',
      tracks: ['voce'],
      model: 'medium',
      language: null
    })
    const good = await ctx.history.createLive({
      title: 'B',
      tracks: ['voce'],
      model: 'medium',
      language: null
    })
    for (const meta of [broken, good]) {
      await ctx.history.update(meta.id, { status: 'interrupted' })
      await writeFile(join(ctx.history.paths(meta.id).dir, 'live-voce.wav'), Buffer.alloc(100))
    }
    ctx.worker.request.mockImplementation((command: WorkerCommand) => {
      if (command.cmd === 'live_finalize' && command.params.dir.includes(broken.id)) {
        return Promise.reject(new AppError('INVALID_MEDIA', 'quebrado'))
      }
      return Promise.resolve({ durations: { voce: 5 } })
    })
    await ctx.service.recover()
    expect(await ctx.history.get(broken.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_MEDIA' }
    })
    expect(await ctx.history.get(good.id)).toMatchObject({ status: 'interrupted', duration: 5 })
  })

  it('recuperação ignora sessões sem gravação e itens de arquivo', async () => {
    const ctx = await setup()
    const live = await ctx.history.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'medium',
      language: null
    })
    await ctx.history.update(live.id, { status: 'interrupted' })
    await ctx.history.create({
      sourcePath: '/a.mp3',
      mediaKind: 'audio',
      model: 'medium',
      language: null
    })
    await ctx.service.recover()
    expect(ctx.requests).toEqual([])
  })

  it('parar sem sessão não faz nada', async () => {
    const ctx = await setup()
    expect(await ctx.service.stop()).toBeNull()
    ctx.service.pause()
    ctx.service.resume()
    ctx.service.audio('voce', 0, block())
    expect(ctx.notified).toEqual([])
  })
})

describe('LiveService — detalhes', () => {
  it('idioma fixo nas configurações vai para o worker; sem modelo escolhido não começa', async () => {
    const ctx = await setup({}, { audioLanguage: 'pt' })
    await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    expect(ctx.requests[0]).toMatchObject({ params: { language: 'pt' } })
    await ctx.service.stop()
    const noModel = await setup({}, { model: null })
    await expect(
      noModel.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === 'MODEL_NOT_LOADED')
  })

  it('modo teste que falha ao começar não cria item', async () => {
    const ctx = await setup({
      worker: { request: () => Promise.reject(new AppError('INTERNAL', 'x')), notify: () => true }
    })
    await expect(ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })).rejects.toThrow()
    expect((await ctx.history.list()).entries).toEqual([])
  })

  it('bloco repetido é ignorado; trecho no modo teste só aparece na tela', async () => {
    const ctx = await setup()
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    ctx.service.audio('voce', 0, block())
    ctx.service.audio('voce', 0, block())
    expect(ctx.notified).toHaveLength(1)
    ctx.service.onWorkerEvent(segmentEvent(sessionId, 'Testando.'))
    expect(ctx.events).toContainEqual(
      expect.objectContaining({ type: 'segment', text: 'Testando.' })
    )
    await ctx.service.stop()
    expect((await ctx.history.list()).entries).toEqual([])
  })

  it('erro de gravação que não é disco cheio vira INTERNAL', async () => {
    const ctx = await setup({
      openWav: () =>
        Promise.resolve({
          samples: 0,
          append: () => Promise.reject(new Error('EIO')),
          close: () => Promise.resolve()
        })
    })
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    ctx.service.audio('voce', 0, block())
    await vi.waitFor(() => {
      expect(ctx.events).toContainEqual({ type: 'error', code: 'INTERNAL' })
    })
  })

  it('finalização sem durações: duração 0', async () => {
    const ctx = await setup({
      worker: { request: () => Promise.resolve({}), notify: () => true }
    })
    await ctx.service.start({ tracks: ['voce'], test: false, title: 'R' })
    expect(await ctx.service.stop()).toMatchObject({ status: 'done', duration: 0 })
  })

  it('erros do worker: código desconhecido vira INTERNAL; só falha de GPU recarrega; recarga que falha é registrada', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const ctx = await setup({
      logger,
      queue: {
        holdForLive: () => Promise.resolve(),
        releaseLive: vi.fn(),
        reloadLiveOnCpu: vi.fn(() => Promise.reject(new Error('sem CPU?')))
      }
    })
    const { sessionId } = await ctx.service.start({ tracks: ['voce'], test: true, title: 'T' })
    ctx.service.onWorkerEvent({ type: 'live_error', session_id: sessionId, code: 'ALGO_NOVO' })
    ctx.service.onWorkerEvent({ type: 'live_error', session_id: sessionId, code: 'NO_AUDIO' })
    expect(ctx.events).toContainEqual({ type: 'error', code: 'INTERNAL' })
    expect(ctx.events).toContainEqual({ type: 'error', code: 'NO_AUDIO' })
    ctx.service.onWorkerEvent({ type: 'live_error', session_id: sessionId, code: 'CUDA_FAILED' })
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('recarregar'))
    })
    await ctx.service.stop()
  })
})
