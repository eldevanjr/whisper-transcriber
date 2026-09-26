import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HistoryStore } from '../../../src/main/history/store'
import { TranscriptionQueue, type QueueDeps } from '../../../src/main/queue/queue'
import type { RequestOptions, WorkerPort } from '../../../src/main/worker/supervisor'
import type { WorkerCommand } from '../../../src/main/worker/protocol'
import { AppError } from '../../../src/shared/errors'
import type { QueueEvent } from '../../../src/shared/events'
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings'
import { FakeChild, flush } from '../../helpers/fake-child'
import { makeTempDir } from '../../helpers/tmp'
import { WorkerSupervisor } from '../../../src/main/worker/supervisor'

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

type Script = (command: WorkerCommand, options: RequestOptions) => Promise<Record<string, unknown>>

class FakeWorker implements WorkerPort {
  calls: { command: WorkerCommand; options: RequestOptions }[] = []
  killed = 0
  constructor(public script: Script) {}
  request(command: WorkerCommand, options: RequestOptions = {}) {
    this.calls.push({ command, options })
    return this.script(command, options)
  }
  kill() {
    this.killed += 1
  }
}

const transcribeOk: Script = (command, options) => {
  if (command.cmd !== 'transcribe') return Promise.resolve({ loaded: true })
  const job = command.params.job_id
  options.onEvent?.({ type: 'phase', phase: 'transcribing', job_id: job })
  options.onEvent?.({ type: 'segment', job_id: job, index: 0, start: 0, end: 1.5, text: 'Olá' })
  options.onEvent?.({
    type: 'progress',
    job_id: job,
    pct: 100,
    processed_s: 2,
    total_s: 2,
    speed: 3
  })
  options.onEvent?.({ type: 'done', job_id: job, duration: 2, language_detected: 'pt' })
  return Promise.resolve({ segments: 1 })
}

async function setup(script: Script = transcribeOk, settings: Partial<Settings> = {}) {
  const dir = await makeTempDir()
  let tick = 0
  const history = new HistoryStore(
    join(dir, 'history'),
    () => new Date(Date.UTC(2026, 8, 23, 10, 0, tick++))
  )
  let current: Settings = { ...DEFAULT_SETTINGS, model: 'medium', ...settings }
  const events: QueueEvent[] = []
  const worker = new FakeWorker(script)
  const deps: QueueDeps = {
    history,
    settings: { get: () => current },
    worker,
    modelDir: (id, format) => (format === 'ggml' ? `/ggml/${id}` : `/models/${id}`),
    cudaLibDir: '/cuda',
    emit: (e) => events.push(e),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    isFile: (path) => Promise.resolve(!path.includes('inexistente'))
  }
  const queue = new TranscriptionQueue(deps)
  // Como o SettingsStore real: cada mudança gera um objeto novo.
  const updateSettings = (patch: Partial<Settings>) => {
    current = { ...current, ...patch }
  }
  return { queue, history, events, worker, updateSettings, deps }
}

const statuses = (events: QueueEvent[]) =>
  events.flatMap((e) => (e.type === 'job' ? [e.meta.status] : []))

describe('TranscriptionQueue', () => {
  it('transcreve um arquivo de ponta a ponta', async () => {
    const { queue, history, events, worker } = await setup()
    const { accepted, rejected } = await queue.enqueue(['/v/aula.mp4', '/v/nota.pdf'])
    expect(rejected).toEqual(['/v/nota.pdf'])
    await queue.whenIdle()
    const id = accepted[0]!.id
    expect(statuses(events)).toEqual(['queued', 'processing', 'done'])
    expect(worker.calls.map((c) => c.command)).toEqual([
      {
        cmd: 'load_model',
        params: {
          model_dir: '/models/medium',
          device: 'cpu',
          engine: 'faster-whisper',
          compute_type: 'int8'
        }
      },
      {
        cmd: 'transcribe',
        params: {
          job_id: id,
          input_path: '/v/aula.mp4',
          language: 'pt',
          audio_out_path: history.paths(id).audio
        }
      }
    ])
    expect(events).toContainEqual({ type: 'phase', jobId: id, phase: 'transcribing' })
    expect(events).toContainEqual({
      type: 'segment',
      jobId: id,
      segment: { start: 0, end: 1.5, text: 'Olá' }
    })
    expect(events).toContainEqual({
      type: 'progress',
      jobId: id,
      pct: 100,
      processedS: 2,
      totalS: 2,
      speed: 3
    })
    expect(await history.readTranscript(id)).toEqual([{ inicio: 0, fim: 1.5, texto: 'Olá' }])
    expect(await history.get(id)).toMatchObject({
      status: 'done',
      duration: 2,
      languageDetected: 'pt'
    })
    expect(queue.isIdle()).toBe(true)
  })

  it('processa um por vez, na ordem, lendo as configurações no início de cada job', async () => {
    // O 1º job começa dentro do enqueue (lê 'pt'); a mudança vale a partir do 2º.
    const order: string[] = []
    const ctx = await setup((command, options) => {
      if (command.cmd === 'transcribe') order.push(`${command.params.input_path}@${options.device}`)
      return Promise.resolve({})
    })
    await ctx.queue.enqueue(['/a.mp3', '/b.mp3'])
    ctx.updateSettings({ audioLanguage: 'auto' })
    await ctx.queue.whenIdle()
    expect(order).toEqual(['/a.mp3@cpu', '/b.mp3@cpu'])
    const languages = ctx.worker.calls.flatMap((c) =>
      c.command.cmd === 'transcribe' ? [c.command.params.language] : []
    )
    expect(languages).toEqual(['pt', null])
  })

  it('GPU usa float16 e a pasta do CUDA', async () => {
    const ctx = await setup(transcribeOk, { device: 'cuda' })
    await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    expect(ctx.worker.calls[0]).toEqual({
      command: {
        cmd: 'load_model',
        params: {
          model_dir: '/models/medium',
          device: 'cuda',
          engine: 'faster-whisper',
          compute_type: 'float16',
          cuda_lib_dir: '/cuda'
        }
      },
      options: { device: 'cuda' }
    })
  })

  it('GPU (Vulkan/Metal) usa o whisper.cpp com o modelo GGML, sem compute_type', async () => {
    const ctx = await setup(transcribeOk, { device: 'gpu' })
    await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    expect(ctx.worker.calls[0]).toEqual({
      command: {
        cmd: 'load_model',
        params: { model_dir: '/ggml/medium', device: 'gpu', engine: 'whisper-cpp' }
      },
      options: { device: 'gpu' }
    })
  })

  it('GPU do whisper.cpp falhou: refaz na CPU com o mesmo modelo GGML', async () => {
    const ctx = await setup(
      (command, options) =>
        options.device === 'gpu'
          ? Promise.reject(new AppError('GPU_FAILED', 'vulkan'))
          : transcribeOk(command, options),
      { device: 'gpu' }
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    const loads = ctx.worker.calls.filter((c) => c.command.cmd === 'load_model')
    expect(loads.at(-1)?.command).toEqual({
      cmd: 'load_model',
      params: { model_dir: '/ggml/medium', device: 'cpu', engine: 'whisper-cpp' }
    })
    expect(ctx.events).toContainEqual({
      type: 'notice',
      jobId: accepted[0]!.id,
      code: 'CUDA_FALLBACK'
    })
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('done')
  })

  it.each(['CUDA_FAILED', 'CUDA_UNAVAILABLE', 'WORKER_CRASHED'] as const)(
    'falha de GPU (%s) refaz o job na CPU com aviso',
    async (code) => {
      const ctx = await setup(
        (command, options) => {
          if (options.device === 'cuda') return Promise.reject(new AppError(code, 'gpu caiu'))
          return transcribeOk(command, options)
        },
        { device: 'cuda' }
      )
      const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
      await ctx.queue.whenIdle()
      expect(ctx.events).toContainEqual({
        type: 'notice',
        jobId: accepted[0]!.id,
        code: 'CUDA_FALLBACK'
      })
      expect(statuses(ctx.events).at(-1)).toBe('done')
    }
  )

  it('outros erros marcam failed com o código, descartam saídas e seguem para o próximo', async () => {
    const ctx = await setup((command, options) => {
      if (command.cmd === 'transcribe' && command.params.input_path === '/ruim.mp4') {
        return Promise.reject(new AppError('INVALID_MEDIA', 'ilegível'))
      }
      return transcribeOk(command, options)
    })
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp4', '/bom.mp4'])
    await ctx.queue.whenIdle()
    expect(await ctx.history.get(accepted[0]!.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_MEDIA', message: 'ilegível' }
    })
    expect((await ctx.history.get(accepted[1]!.id)).status).toBe('done')
  })

  it('falha ao gravar trechos (disco cheio) marca failed com o código', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.history, 'appendSegment').mockRejectedValue(
      new AppError('DISK_FULL', 'sem espaço')
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    expect(await ctx.history.get(accepted[0]!.id)).toMatchObject({
      status: 'failed',
      error: { code: 'DISK_FULL' }
    })
  })

  it('erro de GPU em CPU não tenta de novo', async () => {
    const ctx = await setup(() => Promise.reject(new AppError('CUDA_FAILED', 'x')))
    await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    expect(ctx.events.some((e) => e.type === 'notice')).toBe(false)
  })

  it('cancel() mata o worker e marca canceled', async () => {
    let fail: (e: AppError) => void = () => undefined
    const ctx = await setup((command) => {
      if (command.cmd !== 'transcribe') return Promise.resolve({})
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    })
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await vi.waitFor(() => {
      expect(ctx.worker.calls.some((c) => c.command.cmd === 'transcribe')).toBe(true)
    })
    ctx.worker.kill = () => {
      fail(new AppError('CANCELED', 'cancelada'))
    }
    ctx.queue.cancel()
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('canceled')
    ctx.queue.cancel() // ocioso: não faz nada
  })

  it('remove tira da fila; o atual não pode ser removido', async () => {
    let release: () => void = () => undefined
    const ctx = await setup((command) =>
      command.cmd === 'transcribe'
        ? new Promise((resolve) => {
            release = () => {
              resolve({})
            }
          })
        : Promise.resolve({})
    )
    const first = await ctx.queue.enqueue(['/a.mp3'])
    await vi.waitFor(() => {
      expect(ctx.queue.state().current).toBe(first.accepted[0]!.id)
    })
    const second = await ctx.queue.enqueue(['/b.mp3']) // chega com outro em andamento
    const accepted = [...first.accepted, ...second.accepted]
    expect(ctx.queue.state()).toEqual({ current: accepted[0]!.id, pending: [accepted[1]!.id] })
    await ctx.queue.remove(accepted[1]!.id)
    expect(ctx.events).toContainEqual({ type: 'removed', jobId: accepted[1]!.id })
    await expect(ctx.queue.remove(accepted[0]!.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST'
    )
    release()
    await ctx.queue.whenIdle()
    expect(ctx.queue.state()).toEqual({ current: null, pending: [] })
  })

  it('enqueue só com arquivos não suportados não chama o worker', async () => {
    const ctx = await setup()
    expect(await ctx.queue.enqueue(['/a.pdf'])).toEqual({ accepted: [], rejected: ['/a.pdf'] })
    await ctx.queue.whenIdle()
    expect(ctx.worker.calls).toEqual([])
  })

  it('cancelar em GPU não tenta de novo na CPU', async () => {
    let fail: (e: AppError) => void = () => undefined
    const ctx = await setup(
      (command) =>
        command.cmd === 'transcribe'
          ? new Promise((_resolve, reject) => {
              fail = reject
            })
          : Promise.resolve({}),
      { device: 'cuda' }
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await vi.waitFor(() => {
      expect(ctx.worker.calls.some((c) => c.command.cmd === 'transcribe')).toBe(true)
    })
    ctx.worker.kill = () => {
      fail(new AppError('WORKER_CRASHED', 'morto pelo cancelamento'))
    }
    ctx.queue.cancel()
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('canceled')
    expect(ctx.events.some((e) => e.type === 'notice')).toBe(false)
  })

  it('enqueue sem modelo configurado → MODEL_NOT_LOADED', async () => {
    const ctx = await setup(transcribeOk, { model: null })
    await expect(ctx.queue.enqueue(['/a.mp3'])).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'MODEL_NOT_LOADED'
    )
  })

  it('restore: processing vira interrupted e queued volta à fila na ordem', async () => {
    const ctx = await setup()
    const meta = {
      sourcePath: '/x.mp3',
      mediaKind: 'audio' as const,
      model: 'medium' as const,
      language: 'pt'
    }
    const interrupted = await ctx.history.create(meta)
    await ctx.history.update(interrupted.id, { status: 'processing' })
    const first = await ctx.history.create(meta)
    const second = await ctx.history.create(meta)
    await ctx.queue.restore()
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(interrupted.id)).status).toBe('interrupted')
    const transcribed = ctx.worker.calls.flatMap((c) =>
      c.command.cmd === 'transcribe' ? [c.command.params.job_id] : []
    )
    expect(transcribed).toEqual([first.id, second.id])
  })

  it('selfTest carrega o modelo configurado e roda o autoteste', async () => {
    const ctx = await setup(() => Promise.resolve({ ok: true }))
    await ctx.queue.selfTest()
    expect(ctx.worker.calls.map((c) => c.command.cmd)).toEqual(['load_model', 'self_test'])
  })

  it('selfTest sem modelo → MODEL_NOT_LOADED', async () => {
    const ctx = await setup(transcribeOk, { model: null })
    await expect(ctx.queue.selfTest()).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'MODEL_NOT_LOADED'
    )
  })

  it('disco cheio num job não contamina o próximo', async () => {
    const ctx = await setup()
    const append = vi.spyOn(ctx.history, 'appendSegment')
    append.mockRejectedValueOnce(new AppError('DISK_FULL', 'sem espaço'))
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/b.mp3'])
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('failed')
    expect((await ctx.history.get(accepted[1]!.id)).status).toBe('done')
  })

  it('se gravar o status de falha também falhar, a fila avisa e segue para o próximo', async () => {
    const ctx = await setup((command, options) => {
      if (command.cmd === 'transcribe' && command.params.input_path === '/ruim.mp4') {
        return Promise.reject(new AppError('INVALID_MEDIA', 'ilegível'))
      }
      return transcribeOk(command, options)
    })
    const update = ctx.history.update.bind(ctx.history)
    vi.spyOn(ctx.history, 'update').mockImplementation((id, patch) =>
      patch.status === 'failed'
        ? Promise.reject(new AppError('DISK_FULL', 'sem espaço'))
        : update(id, patch)
    )
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp4', '/bom.mp4'])
    await ctx.queue.whenIdle()
    const failedEvent = ctx.events.find(
      (e) => e.type === 'job' && e.meta.id === accepted[0]!.id && e.meta.status === 'failed'
    )
    expect(failedEvent).toMatchObject({ meta: { error: { code: 'INVALID_MEDIA' } } })
    expect((await ctx.history.get(accepted[1]!.id)).status).toBe('done')
    expect(ctx.queue.state()).toEqual({ current: null, pending: [] })
    expect(ctx.deps.logger.error).toHaveBeenCalled()
  })

  it('se nenhuma gravação de status funcionar num job, a fila registra e segue', async () => {
    const ctx = await setup()
    const update = ctx.history.update.bind(ctx.history)
    let failures = 2 // processing e depois failed
    vi.spyOn(ctx.history, 'update').mockImplementation((id, patch) => {
      if (failures > 0) {
        failures -= 1
        return Promise.reject(new AppError('DISK_FULL', 'sem espaço'))
      }
      return update(id, patch)
    })
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/b.mp3'])
    await ctx.queue.whenIdle()
    expect(ctx.deps.logger.error).toHaveBeenCalledWith(
      '[fila] não foi possível gravar a falha (DISK_FULL): sem espaço'
    )
    expect((await ctx.history.get(accepted[1]!.id)).status).toBe('done')
  })

  it('cancelar durante a finalização cancela o job e não vaza para o próximo', async () => {
    const ctx = await setup((command, options) => {
      if (command.cmd === 'transcribe' && command.params.input_path === '/ruim.mp4') {
        return Promise.reject(new AppError('INVALID_MEDIA', 'ilegível'))
      }
      return transcribeOk(command, options)
    })
    const finalize = ctx.history.finalize.bind(ctx.history)
    vi.spyOn(ctx.history, 'finalize').mockImplementationOnce(async (id) => {
      ctx.queue.cancel() // sem requisição pendente no worker: nada seria rejeitado
      return finalize(id)
    })
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/ruim.mp4'])
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('canceled')
    expect(await ctx.history.get(accepted[1]!.id)).toMatchObject({
      status: 'failed',
      error: { code: 'INVALID_MEDIA' }
    })
  })

  it('cancelar enquanto o modelo carrega não chega a transcrever', async () => {
    let loaded: () => void = () => undefined
    const ctx = await setup((command, options) =>
      command.cmd === 'load_model'
        ? new Promise((resolve) => {
            loaded = () => {
              resolve({})
            }
          })
        : transcribeOk(command, options)
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await vi.waitFor(() => {
      expect(ctx.worker.calls).toHaveLength(1)
    })
    ctx.queue.cancel()
    loaded()
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('canceled')
    expect(ctx.worker.calls.map((c) => c.command.cmd)).toEqual(['load_model'])
  })

  it('GPU do whisper.cpp falhou com o modelo da CPU instalado: segue no faster-whisper', async () => {
    // O whisper.cpp na CPU compartilha o binário (e os modos de falha) da GPU e é mais lento.
    const ctx = await setup(
      (command, options) =>
        options.device === 'gpu'
          ? Promise.reject(new AppError('GPU_FAILED', 'vulkan'))
          : transcribeOk(command, options),
      { device: 'gpu' }
    )
    const hasModel = vi.fn((id: string, format: string) =>
      Promise.resolve(id === 'medium' && format === 'ct2')
    )
    const queue = new TranscriptionQueue({ ...ctx.deps, hasModel })
    const { accepted } = await queue.enqueue(['/a.mp3', '/b.mp3'])
    await queue.whenIdle()
    const loads = ctx.worker.calls.filter((c) => c.command.cmd === 'load_model')
    expect(loads.at(-1)?.command).toEqual({
      cmd: 'load_model',
      params: {
        model_dir: '/models/medium',
        device: 'cpu',
        engine: 'faster-whisper',
        compute_type: 'int8'
      }
    })
    expect(loads.filter((c) => c.options.device === 'gpu')).toHaveLength(1)
    for (const meta of accepted) expect((await ctx.history.get(meta.id)).status).toBe('done')
    expect(hasModel).toHaveBeenCalledWith('medium', 'ct2')
  })

  it('depois de uma falha de GPU o resto da sessão usa a CPU direto', async () => {
    const ctx = await setup(
      (command, options) =>
        options.device === 'cuda'
          ? Promise.reject(new AppError('WORKER_CRASHED', 'cuDNN abortou'))
          : transcribeOk(command, options),
      { device: 'cuda' }
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/b.mp3', '/c.mp3'])
    await ctx.queue.whenIdle()
    for (const meta of accepted) expect((await ctx.history.get(meta.id)).status).toBe('done')
    expect(ctx.worker.calls.filter((c) => c.options.device === 'cuda')).toHaveLength(1)
    expect(ctx.events.filter((e) => e.type === 'notice')).toHaveLength(1)
  })

  it('mudar as configurações volta a tentar a GPU', async () => {
    const ctx = await setup(
      (command, options) =>
        options.device === 'cuda'
          ? Promise.reject(new AppError('CUDA_FAILED', 'x'))
          : transcribeOk(command, options),
      { device: 'cuda' }
    )
    await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    ctx.updateSettings({ device: 'cuda' })
    await ctx.queue.enqueue(['/b.mp3'])
    await ctx.queue.whenIdle()
    expect(ctx.worker.calls.filter((c) => c.options.device === 'cuda')).toHaveLength(2)
  })

  it('selfTest com a fila ocupada é recusado', async () => {
    let release: () => void = () => undefined
    const ctx = await setup((command) =>
      command.cmd === 'transcribe'
        ? new Promise((resolve) => {
            release = () => {
              resolve({})
            }
          })
        : Promise.resolve({})
    )
    await ctx.queue.enqueue(['/a.mp3'])
    await expect(ctx.queue.selfTest()).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST'
    )
    await vi.waitFor(() => {
      expect(ctx.worker.calls.map((c) => c.command.cmd)).toContain('transcribe')
    })
    release()
    await ctx.queue.whenIdle()
  })

  it('arquivos enfileirados durante o autoteste esperam ele terminar', async () => {
    let finishTest: () => void = () => undefined
    const ctx = await setup((command, options) =>
      command.cmd === 'self_test'
        ? new Promise((resolve) => {
            finishTest = () => {
              resolve({ ok: true })
            }
          })
        : transcribeOk(command, options)
    )
    const test = ctx.queue.selfTest()
    await vi.waitFor(() => {
      expect(ctx.worker.calls.map((c) => c.command.cmd)).toContain('self_test')
    })
    await expect(ctx.queue.selfTest()).rejects.toBeInstanceOf(AppError)
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    expect(ctx.queue.isIdle()).toBe(false)
    expect(ctx.worker.calls.map((c) => c.command.cmd)).toEqual(['load_model', 'self_test'])
    finishTest()
    await test
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('done')
  })
})

describe('TranscriptionQueue — validação, repetir e excluir', () => {
  const failing: Script = (command, options) =>
    command.cmd === 'transcribe' && command.params.input_path.includes('ruim')
      ? Promise.reject(new AppError('INVALID_MEDIA', 'ilegível'))
      : transcribeOk(command, options)

  it('enqueue rejeita caminho relativo e arquivo inexistente', async () => {
    const ctx = await setup()
    const result = await ctx.queue.enqueue(['relativo.mp3', '/inexistente.mp3', '/ok.mp3'])
    expect(result.rejected).toEqual(['relativo.mp3', '/inexistente.mp3'])
    expect(result.accepted.map((m) => m.sourcePath)).toEqual(['/ok.mp3'])
    await ctx.queue.whenIdle()
  })

  it('por padrão confere no disco se o caminho é um arquivo', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'a.mp3')
    await writeFile(file, 'x')
    const ctx = await setup()
    delete ctx.deps.isFile
    const queue = new TranscriptionQueue(ctx.deps)
    const result = await queue.enqueue([file, join(dir, 'b.mp3'), `${dir}/pasta.mp3`])
    expect(result.accepted.map((m) => m.sourcePath)).toEqual([file])
    await queue.whenIdle()
  })

  it('retry de um job que falhou volta para a fila, apaga o parcial antigo e roda', async () => {
    const ctx = await setup(failing)
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp3'])
    await ctx.queue.whenIdle()
    const id = accepted[0]!.id
    await ctx.history.appendSegment(id, { start: 0, end: 1, text: 'velho' })
    ctx.worker.script = transcribeOk
    const meta = await ctx.queue.retry(id)
    expect(meta).toMatchObject({ id, status: 'queued', error: null })
    await ctx.queue.whenIdle()
    expect(await ctx.history.get(id)).toMatchObject({ status: 'done' })
    expect(await ctx.history.readTranscript(id)).toEqual([{ inicio: 0, fim: 1.5, texto: 'Olá' }])
  })

  it('retry em dobro (clique duplo) enfileira uma vez só', async () => {
    const ctx = await setup(failing)
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp3'])
    await ctx.queue.whenIdle()
    ctx.worker.script = (command, options) =>
      command.cmd === 'transcribe' ? new Promise(() => undefined) : transcribeOk(command, options)
    const id = accepted[0]!.id
    const results = await Promise.allSettled([ctx.queue.retry(id), ctx.queue.retry(id)])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await vi.waitFor(() => {
      expect(ctx.queue.state().current).toBe(id)
    })
    expect(ctx.queue.state().pending).toEqual([])
  })

  it('retry com novo caminho troca o arquivo (localizar arquivo movido)', async () => {
    const ctx = await setup(failing)
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp4'])
    await ctx.queue.whenIdle()
    const meta = await ctx.queue.retry(accepted[0]!.id, '/novo/lugar/aula.mp3')
    expect(meta).toMatchObject({
      sourcePath: '/novo/lugar/aula.mp3',
      fileName: 'aula.mp3',
      mediaKind: 'audio'
    })
    await ctx.queue.whenIdle()
  })

  it('cancelado ou com falha guarda o áudio extraído; refazer reaproveita (não apaga)', async () => {
    const script: Script = async (command, options) => {
      if (command.cmd !== 'transcribe') return { loaded: true }
      // o worker extraiu o áudio e o job falhou/foi cancelado depois
      await writeFile(command.params.audio_out_path, 'm4a')
      await writeFile(ctx.history.paths(command.params.job_id).partial, 'x')
      if (command.params.input_path.includes('ruim')) throw new AppError('INTERNAL', 'caiu')
      return transcribeOk(command, options)
    }
    const ctx = await setup(script) // o script só roda depois: ctx já existe
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp3'])
    await ctx.queue.whenIdle()
    const id = accepted[0]!.id
    const paths = ctx.history.paths(id)
    expect((await ctx.history.get(id)).status).toBe('failed')
    expect(await exists(paths.audio)).toBe(true)
    expect(await exists(paths.partial)).toBe(false)
    await ctx.queue.retry(id)
    expect(await exists(paths.audio)).toBe(true)
  })

  it('refazer com outro arquivo descarta o áudio do arquivo antigo', async () => {
    const ctx = await setup(failing)
    const { accepted } = await ctx.queue.enqueue(['/ruim.mp4'])
    await ctx.queue.whenIdle()
    const id = accepted[0]!.id
    ctx.worker.script = () => new Promise(() => undefined) // não termina: o arquivo fica como está
    await writeFile(ctx.history.paths(id).audio, 'm4a antigo')
    await ctx.queue.retry(id, '/novo/lugar/aula.mp3')
    expect(await exists(ctx.history.paths(id).audio)).toBe(false)
  })

  it('retry de concluído transcreve de novo (ex.: nenhuma fala reconhecida)', async () => {
    const ctx = await setup()
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    const id = accepted[0]!.id
    const meta = await ctx.queue.retry(id)
    expect(meta.status).toBe('queued')
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(id)).status).toBe('done')
    expect(ctx.worker.calls.filter((c) => c.command.cmd === 'transcribe')).toHaveLength(2)
  })

  it('retry recusa item ainda na fila e caminhos inválidos', async () => {
    const ctx = await setup(failing)
    const { accepted } = await ctx.queue.enqueue(['/bom.mp3', '/ruim.mp3'])
    await ctx.queue.whenIdle()
    const failed = accepted[1]!.id
    const queued = await ctx.history.create({
      sourcePath: '/x.mp3',
      mediaKind: 'audio',
      model: 'medium',
      language: 'pt'
    })
    await expect(ctx.queue.retry(queued.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST'
    )
    await expect(ctx.queue.retry(failed, '/nota.pdf')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'UNSUPPORTED_FILE'
    )
    await expect(ctx.queue.retry(failed, '/inexistente.mp3')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'FILE_NOT_FOUND'
    )
  })

  it('retry de interrompido e cancelado também funciona', async () => {
    const ctx = await setup()
    const meta = {
      sourcePath: '/x.mp3',
      mediaKind: 'audio' as const,
      model: 'medium' as const,
      language: 'pt'
    }
    const a = await ctx.history.create(meta)
    await ctx.history.update(a.id, { status: 'interrupted' })
    const b = await ctx.history.create(meta)
    await ctx.history.update(b.id, { status: 'canceled' })
    await ctx.queue.retry(a.id)
    await ctx.queue.retry(b.id)
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(a.id)).status).toBe('done')
    expect((await ctx.history.get(b.id)).status).toBe('done')
  })

  it('removeEntry apaga do histórico, inclusive entradas corrompidas', async () => {
    const ctx = await setup()
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await ctx.queue.whenIdle()
    const id = accepted[0]!.id
    await ctx.queue.removeEntry(id)
    expect(ctx.events).toContainEqual({ type: 'removed', jobId: id })
    expect((await ctx.history.list()).entries).toEqual([])
  })

  it('removeEntry recusa o job atual e os que estão na fila', async () => {
    let release: () => void = () => undefined
    const ctx = await setup((command) =>
      command.cmd === 'transcribe'
        ? new Promise((resolve) => {
            release = () => {
              resolve({})
            }
          })
        : Promise.resolve({})
    )
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/b.mp3'])
    await vi.waitFor(() => {
      expect(ctx.worker.calls.map((c) => c.command.cmd)).toContain('transcribe')
    })
    for (const meta of accepted) {
      await expect(ctx.queue.removeEntry(meta.id)).rejects.toSatisfy(
        (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST'
      )
    }
    release()
    await vi.waitFor(() => {
      expect(ctx.worker.calls.filter((c) => c.command.cmd === 'transcribe')).toHaveLength(2)
    })
    release()
    await ctx.queue.whenIdle()
  })
})

describe('TranscriptionQueue com o supervisor real', () => {
  async function realSetup(settings: Partial<Settings> = {}) {
    const children: FakeChild[] = []
    const worker = new WorkerSupervisor({
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
      commandLine: { command: 'worker', args: [] },
      envFor: () => ({}),
      expectedVersion: '0.1.0',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sleep: () => Promise.resolve()
    })
    const dir = await makeTempDir()
    const history = new HistoryStore(join(dir, 'history'))
    const queue = new TranscriptionQueue({
      history,
      settings: { get: () => ({ ...DEFAULT_SETTINGS, model: 'medium', ...settings }) },
      worker,
      modelDir: (id, format) => (format === 'ggml' ? `/ggml/${id}` : `/models/${id}`),
      cudaLibDir: '/cuda',
      emit: () => undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      isFile: () => Promise.resolve(true)
    })
    return { children, worker, history, queue }
  }

  it('fechar o app no meio de um job deixa ele para virar interrompido e não inicia outro motor', async () => {
    const ctx = await realSetup()
    const { accepted } = await ctx.queue.enqueue(['/a.mp3', '/b.mp3'])
    await vi.waitFor(() => {
      expect(ctx.children).toHaveLength(1)
    })
    const child = ctx.children[0]!
    child.ready()
    await vi.waitFor(() => {
      expect(child.commands()).toHaveLength(1)
    })
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await vi.waitFor(() => {
      expect(child.lastCommand().cmd).toBe('transcribe')
    })
    ctx.queue.shutdown()
    ctx.worker.dispose()
    await ctx.queue.whenIdle()
    await flush()
    expect(ctx.children).toHaveLength(1)
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('processing')
    expect((await ctx.history.get(accepted[1]!.id)).status).toBe('queued')
    await ctx.queue.enqueue(['/c.mp3']) // chegou depois do fechamento: fica gravado, não roda
    await flush()
    expect(ctx.children).toHaveLength(1)
  })
})

describe('queda da GPU no ao vivo com o supervisor real', () => {
  async function answerNext(child: FakeChild, count: number) {
    await vi.waitFor(() => {
      expect(child.commands()).toHaveLength(count)
    })
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
  }

  it.each(['cuda', 'gpu'] as const)(
    '%s: recarrega na CPU no mesmo processo (a sessão ao vivo do worker continua viva)',
    async (device) => {
      const children: FakeChild[] = []
      const worker = new WorkerSupervisor({
        spawn: () => {
          const child = new FakeChild()
          children.push(child)
          return child
        },
        commandLine: { command: 'worker', args: [] },
        envFor: () => ({}),
        expectedVersion: '0.1.0',
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        sleep: () => Promise.resolve()
      })
      const dir = await makeTempDir()
      const queue = new TranscriptionQueue({
        history: new HistoryStore(join(dir, 'history')),
        settings: { get: () => ({ ...DEFAULT_SETTINGS, model: 'medium', device }) },
        worker,
        modelDir: (id, format) => (format === 'ggml' ? `/ggml/${id}` : `/models/${id}`),
        cudaLibDir: '/cuda',
        emit: () => undefined,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        isFile: () => Promise.resolve(true),
        hasModel: () => Promise.resolve(true)
      })
      const holding = queue.holdForLive()
      await vi.waitFor(() => {
        expect(children).toHaveLength(1)
      })
      const child = children[0]!
      child.ready()
      await answerNext(child, 1)
      await holding
      const reloading = queue.reloadLiveOnCpu()
      await answerNext(child, 2)
      await reloading
      expect(children).toHaveLength(1) // nenhum processo novo
      expect(child.lastCommand()).toMatchObject({ cmd: 'load_model', params: { device: 'cpu' } })
      queue.releaseLive()
      worker.dispose()
    }
  )
})

describe('TranscriptionQueue durante o ao vivo', () => {
  it('holdForLive carrega o modelo e segura a fila até releaseLive', async () => {
    const ctx = await setup(transcribeOk, { device: 'cpu' })
    await ctx.queue.holdForLive()
    expect(ctx.worker.calls.at(-1)?.command).toMatchObject({ cmd: 'load_model' })
    expect(ctx.queue.isIdle()).toBe(false)
    const { accepted } = await ctx.queue.enqueue(['/a.mp3'])
    await flush()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('queued') // esperando
    ctx.queue.releaseLive()
    await ctx.queue.whenIdle()
    expect((await ctx.history.get(accepted[0]!.id)).status).toBe('done')
  })

  it('holdForLive recusa com a fila ocupada e libera se o modelo não carregar', async () => {
    const ctx = await setup((command, options) =>
      command.cmd === 'transcribe' ? new Promise(() => undefined) : transcribeOk(command, options)
    )
    await ctx.queue.enqueue(['/a.mp3'])
    await flush()
    await expect(ctx.queue.holdForLive()).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'QUEUE_BUSY'
    )
    const broken = await setup(() => Promise.reject(new AppError('MODEL_LOAD_FAILED', 'x')))
    await expect(broken.queue.holdForLive()).rejects.toThrow()
    expect(broken.queue.isIdle()).toBe(true)
  })

  it('reloadLiveOnCpu troca para a CPU como na queda de GPU da fila', async () => {
    const ctx = await setup(transcribeOk, { device: 'gpu' })
    await ctx.queue.holdForLive()
    expect(ctx.worker.calls.at(-1)?.options.device).toBe('gpu')
    await ctx.queue.reloadLiveOnCpu()
    expect(ctx.worker.calls.at(-1)?.command).toMatchObject({
      cmd: 'load_model',
      params: { device: 'cpu' }
    })
    ctx.queue.releaseLive()
  })
})

describe('refazer o ao vivo', () => {
  async function liveItem(
    history: HistoryStore,
    tracks: ('voce' | 'outros')[] = ['voce', 'outros']
  ) {
    const meta = await history.createLive({
      title: 'Reunião',
      tracks,
      model: 'medium',
      language: 'pt'
    })
    await history.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await history.finalizeLive(meta.id)
    for (const track of tracks) {
      await writeFile(join(history.paths(meta.id).dir, `${track}.m4a`), 'm4a')
    }
    return history.update(meta.id, { status: 'done', duration: 9 })
  }

  // Cada faixa fala num momento: Você em 0 s e 6 s, Outros em 3 s.
  const byTrack: Script = (command, options) => {
    if (command.cmd !== 'transcribe') return Promise.resolve({ loaded: true })
    const job = command.params.job_id
    const outros = command.params.input_path.endsWith('outros.m4a')
    const starts = outros ? [3] : [0, 6]
    for (const [index, start] of starts.entries()) {
      options.onEvent?.({
        type: 'segment',
        job_id: job,
        index,
        start,
        end: start + 1,
        text: `${outros ? 'O' : 'V'}${start}`
      })
    }
    options.onEvent?.({
      type: 'progress',
      job_id: job,
      pct: 50,
      processed_s: 5,
      total_s: 10,
      speed: 2
    })
    options.onEvent?.({
      type: 'done',
      job_id: job,
      duration: outros ? 10 : 8,
      language_detected: 'pt'
    })
    return Promise.resolve({ segments: starts.length })
  }

  it('transcreve cada faixa inteira, marca o falante e intercala por início', async () => {
    const { queue, history, events, worker } = await setup(byTrack)
    const meta = await liveItem(history)
    await queue.retry(meta.id)
    await queue.whenIdle()
    const dir = history.paths(meta.id).dir
    const transcribes = worker.calls.flatMap((c) =>
      c.command.cmd === 'transcribe' ? [c.command.params] : []
    )
    expect(transcribes).toEqual([
      {
        job_id: meta.id,
        input_path: join(dir, 'voce.m4a'),
        language: 'pt',
        audio_out_path: join(dir, 'voce.m4a')
      },
      {
        job_id: meta.id,
        input_path: join(dir, 'outros.m4a'),
        language: 'pt',
        audio_out_path: join(dir, 'outros.m4a')
      }
    ])
    const final = await history.get(meta.id)
    expect(final).toMatchObject({
      status: 'done',
      activeVersion: 'redo',
      duration: 10,
      languageDetected: 'pt'
    })
    expect(await history.readActive(final)).toEqual([
      { inicio: 0, fim: 1, texto: 'V0', falante: 'voce' },
      { inicio: 3, fim: 4, texto: 'O3', falante: 'outros' },
      { inicio: 6, fim: 7, texto: 'V6', falante: 'voce' }
    ])
    // a versão ao vivo continua guardada
    expect(await history.readActive({ ...final, activeVersion: 'live' })).toEqual([
      { inicio: 0, fim: 1, texto: 'ao vivo', falante: 'voce' }
    ])
    expect(events).toContainEqual({
      type: 'segment',
      jobId: meta.id,
      segment: { start: 3, end: 4, text: 'O3', speaker: 'outros' }
    })
    // o progresso cobre as duas faixas: metade da primeira = 25%, metade da segunda = 75%
    const progress = events.flatMap((e) => (e.type === 'progress' ? [[e.pct, e.pass]] : []))
    expect(progress).toEqual([
      [25, { track: 'voce', index: 0, count: 2 }],
      [75, { track: 'outros', index: 1, count: 2 }]
    ])
  })

  it('falha no refazer mantém a versão ao vivo ativa', async () => {
    const { queue, history } = await setup((command) =>
      command.cmd === 'transcribe'
        ? Promise.reject(new AppError('FILE_NOT_FOUND', 'sem voce.m4a'))
        : Promise.resolve({ loaded: true })
    )
    const meta = await liveItem(history, ['voce'])
    await queue.retry(meta.id)
    await queue.whenIdle()
    const final = await history.get(meta.id)
    expect(final).toMatchObject({ status: 'failed', activeVersion: 'live' })
    expect(await history.hasRedo(final)).toBe(false)
  })

  it('item ao vivo sem faixas registradas: conclui sem nada para transcrever', async () => {
    const { queue, history, worker } = await setup(byTrack)
    const meta = await liveItem(history)
    await history.update(meta.id, { tracks: undefined })
    await queue.retry(meta.id)
    await queue.whenIdle()
    expect(worker.calls.some((c) => c.command.cmd === 'transcribe')).toBe(false)
    expect(await history.get(meta.id)).toMatchObject({ status: 'done', activeVersion: 'redo' })
  })

  it('item ao vivo que não chegou a ser finalizado: refazer guarda antes a versão ao vivo', async () => {
    const { queue, history } = await setup(byTrack)
    const meta = await history.createLive({
      title: 'R',
      tracks: ['voce'],
      model: 'medium',
      language: null
    })
    await history.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await writeFile(join(history.paths(meta.id).dir, 'voce.m4a'), 'm4a')
    await history.update(meta.id, { status: 'failed' })
    await queue.retry(meta.id)
    await queue.whenIdle()
    const final = await history.get(meta.id)
    expect(
      (await history.readActive({ ...final, activeVersion: 'live' })).map((e) => e.texto)
    ).toEqual(['ao vivo'])
  })

  it('sem a gravação convertida (ainda recuperando ou perdida): recusa refazer e não apaga nada', async () => {
    const { queue, history } = await setup(byTrack)
    const meta = await history.createLive({
      title: 'R',
      tracks: ['voce', 'outros'],
      model: 'medium',
      language: null
    })
    await history.appendSegment(meta.id, { start: 0, end: 1, text: 'ao vivo', speaker: 'voce' })
    await writeFile(join(history.paths(meta.id).dir, 'voce.m4a'), 'm4a') // falta outros.m4a
    await history.update(meta.id, { status: 'interrupted' })
    await expect(queue.retry(meta.id)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
    expect(await history.get(meta.id)).toMatchObject({ status: 'interrupted' })
    expect((await history.readActive(meta)).map((e) => e.texto)).toEqual(['ao vivo'])
  })

  it('escolher a versão grava e avisa a tela', async () => {
    const { queue, history, events } = await setup(byTrack)
    const meta = await liveItem(history)
    await queue.retry(meta.id)
    await queue.whenIdle()
    const chosen = await queue.setVersion(meta.id, 'live')
    expect(chosen.activeVersion).toBe('live')
    expect(events.at(-1)).toEqual({ type: 'job', meta: chosen })
    expect((await queue.setVersion(meta.id, 'redo')).activeVersion).toBe('redo')
  })

  it('sem refeita (ou item de arquivo) não há versão para escolher', async () => {
    const { queue, history } = await setup()
    const meta = await liveItem(history)
    await expect(queue.setVersion(meta.id, 'redo')).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
    expect((await queue.setVersion(meta.id, 'live')).activeVersion).toBe('live')
    const file = await history.create({
      sourcePath: '/v/a.mp4',
      mediaKind: 'video',
      model: 'medium',
      language: null
    })
    await expect(queue.setVersion(file.id, 'live')).rejects.toMatchObject({
      code: 'INVALID_REQUEST'
    })
  })
})

describe('TranscriptionQueue.requestedBy', () => {
  it('grava o cliente MCP que pediu a transcrição', async () => {
    const { queue, history } = await setup()
    const { accepted } = await queue.enqueue(['/v/aula.mp4'], { requestedBy: 'claude-code' })
    expect(accepted[0]?.requestedBy).toBe('claude-code')
    expect((await history.get(accepted[0]!.id)).requestedBy).toBe('claude-code')
    await queue.whenIdle()
  })
})
