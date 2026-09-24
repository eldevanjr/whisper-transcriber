import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../../src/shared/errors'
import type { JobEvent } from '../../../src/main/worker/protocol'
import {
  WorkerSupervisor,
  type Logger,
  type SupervisorOptions
} from '../../../src/main/worker/supervisor'
import { FakeChild, flush } from '../../helpers/fake-child'

function setup(overrides: Partial<SupervisorOptions> = {}) {
  const children: FakeChild[] = []
  const envs: string[] = []
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const sleep = vi.fn(() => Promise.resolve())
  let clock = 0
  const supervisor = new WorkerSupervisor({
    spawn: (_command, _args, options) => {
      const child = new FakeChild()
      children.push(child)
      envs.push(String(options.env.DEVICE))
      return child
    },
    commandLine: { command: 'worker', args: [] },
    envFor: (device) => ({ DEVICE: device }),
    expectedVersion: '0.1.0',
    logger,
    now: () => clock,
    sleep,
    ...overrides
  })
  return {
    supervisor,
    children,
    envs,
    logger,
    sleep,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

async function started(ctx: ReturnType<typeof setup>, index = 0): Promise<FakeChild> {
  await flush()
  const child = ctx.children[index]!
  child.ready()
  await flush()
  return child
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code)
}

describe('WorkerSupervisor', () => {
  it('inicia sob demanda, faz handshake e resolve a requisição', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    const command = child.lastCommand()
    expect(command.cmd).toBe('self_test')
    child.send({ type: 'result', id: command.id, data: { ok: true } })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(ctx.envs).toEqual(['cpu'])
  })

  it('reaproveita o processo entre requisições', async () => {
    const ctx = setup()
    const first = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await first
    const second = ctx.supervisor.request({ cmd: 'self_test' })
    await flush()
    child.send({ type: 'phase', phase: 'loading_model', job_id: null }) // pendente sem onEvent
    child.send({ type: 'result', id: child.lastCommand().id, data: { n: 2 } })
    await expect(second).resolves.toEqual({ n: 2 })
    expect(ctx.children).toHaveLength(1)
  })

  it('encaminha eventos do job certo para onEvent', async () => {
    const ctx = setup()
    const events: JobEvent[] = []
    const pending = ctx.supervisor.request(
      {
        cmd: 'transcribe',
        params: { job_id: 'job-1', input_path: '/v', language: null, audio_out_path: '/a' }
      },
      { onEvent: (e) => events.push(e) }
    )
    const child = await started(ctx)
    child.send({ type: 'segment', job_id: 'job-1', index: 0, start: 0, end: 1, text: 'a' })
    child.send({ type: 'segment', job_id: 'outro', index: 0, start: 0, end: 1, text: 'b' })
    child.send({ type: 'heartbeat' })
    child.send({ type: 'result', id: child.lastCommand().id, data: { segments: 1 } })
    await pending
    expect(events.map((e) => e.type === 'segment' && e.text)).toEqual(['a'])
  })

  it('eventos do ao vivo vão para onLiveEvent, sem depender de um job', async () => {
    const live = vi.fn()
    const ctx = setup({ onLiveEvent: live })
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.send({ type: 'live_lag', session_id: 's', seconds: 2 })
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await pending
    expect(live).toHaveBeenCalledWith({ type: 'live_lag', session_id: 's', seconds: 2 })
    const quiet = setup() // sem ouvinte: ignora
    const other = quiet.supervisor.request({ cmd: 'self_test' })
    const child2 = await started(quiet)
    child2.send({ type: 'live_lag', session_id: 's', seconds: 2 })
    child2.send({ type: 'result', id: child2.lastCommand().id, data: {} })
    await other
  })

  it('erro do worker rejeita com o código dele', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.send({
      type: 'error',
      id: child.lastCommand().id,
      code: 'MODEL_NOT_LOADED',
      message: 'm'
    })
    await expectCode(pending, 'MODEL_NOT_LOADED')
  })

  it('versão incompatível rejeita com PROTOCOL_MISMATCH e mata o processo', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    await flush()
    ctx.children[0]!.ready('9.9.9')
    await expectCode(pending, 'PROTOCOL_MISMATCH')
    expect(ctx.children[0]!.killed).toBe(true)
  })

  it('queda do processo rejeita com WORKER_CRASHED; próxima requisição reinicia com espera', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.crash()
    await expectCode(pending, 'WORKER_CRASHED')
    const next = ctx.supervisor.request({ cmd: 'self_test' })
    const second = await started(ctx, 1)
    second.send({ type: 'result', id: second.lastCommand().id, data: {} })
    await next
    expect(ctx.sleep).toHaveBeenCalledWith(1000)
  })

  it('kill() cancela o job atual com CANCELED', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    ctx.supervisor.kill()
    await expectCode(pending, 'CANCELED')
    expect(child.killed).toBe(true)
    await flush()
    ctx.supervisor.kill() // sem processo: não faz nada
    expect(ctx.children).toHaveLength(1)
  })

  it('trocar de dispositivo reinicia o processo com o ambiente certo', async () => {
    const ctx = setup()
    const first = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await first
    const second = ctx.supervisor.request({ cmd: 'self_test' }, { device: 'cuda' })
    const cuda = await started(ctx, 1)
    cuda.send({ type: 'result', id: cuda.lastCommand().id, data: {} })
    await second
    expect(child.killed).toBe(true)
    expect(ctx.envs).toEqual(['cpu', 'cuda'])
    expect(ctx.sleep).not.toHaveBeenCalledWith(1000) // troca intencional não conta como queda
  })

  it('3 quedas em 60 s deixam o motor indisponível; depois da janela volta a tentar', async () => {
    const ctx = setup()
    for (let i = 0; i < 3; i += 1) {
      const pending = ctx.supervisor.request({ cmd: 'self_test' })
      const child = await started(ctx, i)
      child.crash()
      await expectCode(pending, 'WORKER_CRASHED')
    }
    await expectCode(ctx.supervisor.request({ cmd: 'self_test' }), 'WORKER_UNAVAILABLE')
    ctx.advance(60_001)
    const retry = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx, 3)
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await expect(retry).resolves.toEqual({})
  })

  it.each([new Error('spawn uv ENOENT'), 'spawn uv ENOENT'])(
    'erro de spawn (%s) vira WORKER_CRASHED com detalhe',
    async (error) => {
      const ctx = setup()
      const pending = ctx.supervisor.request({ cmd: 'self_test' })
      await flush()
      ctx.children[0]!.emit('error', error)
      await expect(pending).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof AppError && e.code === 'WORKER_CRASHED' && e.detail === 'spawn uv ENOENT'
      )
    }
  )

  it('registra stderr, linhas inválidas, respostas órfãs e erros sem id', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.stderr.write('Carregando modelo...\n')
    child.stdout.write('lixo\n')
    child.send({ type: 'result', id: 'desconhecido', data: {} })
    child.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'linha ruim' })
    child.send({ type: 'result', id: child.lastCommand().id, data: {} })
    await pending
    expect(ctx.logger.info).toHaveBeenCalledWith('[worker] Carregando modelo...')
    expect(ctx.logger.warn).toHaveBeenCalledWith('[worker] linha inválida: lixo')
    expect(ctx.logger.warn).toHaveBeenCalledWith('[worker] resposta sem requisição: desconhecido')
    expect(ctx.logger.warn).toHaveBeenCalledWith('[worker] erro: INVALID_MESSAGE linha ruim')
  })

  it('dispose() encerra o processo', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    ctx.supervisor.dispose()
    await expectCode(pending, 'CANCELED')
    expect(child.killed).toBe(true)
  })

  it('depois de dispose() não inicia outro processo (fechando o app)', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    await started(ctx)
    ctx.supervisor.dispose()
    await expectCode(pending, 'CANCELED')
    await expectCode(ctx.supervisor.request({ cmd: 'self_test' }), 'CANCELED')
    await flush()
    expect(ctx.children).toHaveLength(1)
  })

  it('requisições simultâneas durante a espera de reinício iniciam um processo só', async () => {
    let wake: () => void = () => undefined
    const ctx = setup()
    ctx.sleep.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve
        })
    )
    const first = ctx.supervisor.request({ cmd: 'self_test' })
    ;(await started(ctx)).crash()
    await expectCode(first, 'WORKER_CRASHED')
    const a = ctx.supervisor.request({ cmd: 'self_test' })
    const b = ctx.supervisor.request({ cmd: 'self_test' })
    await flush()
    wake()
    const child = await started(ctx, 1)
    for (const command of child.commands()) {
      child.send({ type: 'result', id: command.id, data: {} })
    }
    await expect(Promise.all([a, b])).resolves.toEqual([{}, {}])
    expect(ctx.children).toHaveLength(2)
  })

  it('dispose() durante a espera de reinício não inicia o processo', async () => {
    let wake: () => void = () => undefined
    const ctx = setup()
    ctx.sleep.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          wake = resolve
        })
    )
    const first = ctx.supervisor.request({ cmd: 'self_test' })
    ;(await started(ctx)).crash()
    await expectCode(first, 'WORKER_CRASHED')
    const next = ctx.supervisor.request({ cmd: 'self_test' })
    await flush()
    ctx.supervisor.dispose()
    wake()
    await expectCode(next, 'CANCELED')
    expect(ctx.children).toHaveLength(1)
  })

  it('erro de escrita no stdin (EPIPE) é registrado sem derrubar o processo principal', async () => {
    const ctx = setup()
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    child.stdin.emit('error', new Error('write EPIPE'))
    expect(ctx.logger.warn).toHaveBeenCalledWith('[worker] falha ao escrever: write EPIPE')
    child.crash()
    await expectCode(pending, 'WORKER_CRASHED')
  })

  it('passa o cwd da linha de comando quando existe', async () => {
    const spawn = vi.fn(() => new FakeChild())
    const supervisor = new WorkerSupervisor({
      spawn,
      commandLine: { command: 'uv', args: ['run'], cwd: '/w' },
      envFor: () => ({}),
      expectedVersion: '0.1.0',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    void supervisor.request({ cmd: 'self_test' }).catch(() => undefined)
    await flush()
    expect(spawn).toHaveBeenCalledWith('uv', ['run'], { env: {}, cwd: '/w' })
    supervisor.dispose()
  })
})

describe('WorkerSupervisor timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sem ready no prazo → WORKER_TIMEOUT', async () => {
    const ctx = setup({ readyTimeoutMs: 1000 })
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    await flush()
    vi.advanceTimersByTime(1000)
    await expectCode(pending, 'WORKER_TIMEOUT')
    expect(ctx.children[0]!.killed).toBe(true)
  })

  it('sem heartbeat por 30 s → WORKER_TIMEOUT', async () => {
    const ctx = setup({ heartbeatTimeoutMs: 30_000 })
    const pending = ctx.supervisor.request({ cmd: 'self_test' })
    const child = await started(ctx)
    vi.advanceTimersByTime(29_000)
    child.send({ type: 'heartbeat' })
    await flush()
    vi.advanceTimersByTime(29_000)
    expect(child.killed).toBe(false)
    vi.advanceTimersByTime(1_000)
    await expectCode(pending, 'WORKER_TIMEOUT')
  })
})
