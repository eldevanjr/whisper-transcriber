import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BackgroundController,
  QUIT_TIMEOUT_MS,
  type BackgroundDeps
} from '../../../src/main/background/controller'
import { createTranslate } from '../../../src/main/background/texts'
import type { TrayState } from '../../../src/main/background/state'
import type { LiveState } from '../../../src/shared/events'
import type { HistoryMeta } from '../../../src/shared/history'

function setup(patch: Partial<BackgroundDeps> = {}) {
  const live = { state: 'idle' as LiveState, stop: vi.fn(() => Promise.resolve(null)) }
  let flags = { hiddenHintShown: false }
  const base = {
    live,
    queueIdle: vi.fn(() => true),
    ready: vi.fn(() => true),
    command: vi.fn(),
    view: { render: vi.fn() },
    notify: vi.fn(),
    badge: vi.fn(),
    shortcut: vi.fn((): string | null => 'CommandOrControl+Alt+R'),
    windowFocused: vi.fn(() => false),
    notifyAi: vi.fn(() => true),
    translate: () => createTranslate('pt-BR'),
    flags: {
      get: () => flags,
      set: vi.fn((next: Partial<typeof flags>) => {
        flags = { ...flags, ...next }
        return Promise.resolve()
      })
    },
    quit: vi.fn(),
    platform: 'linux',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  } satisfies BackgroundDeps
  const deps = { ...base, ...patch } as typeof base
  const controller = new BackgroundController(deps)
  const state = (next: LiveState, test = false, itemId: string | null = 'item1') => {
    live.state = next
    controller.onLiveEvent({ type: 'state', state: next, test, itemId })
  }
  const lastState = (): TrayState => deps.view.render.mock.lastCall![0] as TrayState
  return { controller, deps, live, state, lastState }
}

const meta = (patch: Partial<HistoryMeta>) =>
  ({
    id: 'item1',
    fileName: 'Reunião 26/09',
    status: 'done',
    duration: 725,
    ...patch
  }) as HistoryMeta

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundController: começar e parar', () => {
  it('toggle parado manda o renderer começar; gravando manda parar', () => {
    const { controller, deps, state } = setup()
    controller.toggle()
    expect(deps.command).toHaveBeenLastCalledWith({ action: 'toggle' })
    state('recording')
    controller.toggle()
    expect(deps.command).toHaveBeenCalledTimes(2)
  })

  it('começando ou parando: ignora', () => {
    const { controller, deps, state } = setup()
    state('starting')
    controller.toggle()
    state('stopping')
    controller.toggle()
    expect(deps.command).not.toHaveBeenCalled()
  })

  it('sem modelo ou com a fila ocupada: não abre o microfone, notifica o motivo', () => {
    const noModel = setup({ ready: () => false })
    noModel.controller.toggle()
    expect(noModel.deps.command).not.toHaveBeenCalled()
    expect(noModel.deps.notify).toHaveBeenCalledWith(
      'Não deu para começar a gravar',
      'Termine a configuração do app para gravar.',
      { kind: 'window' }
    )
    const busy = setup({ queueIdle: () => false })
    busy.controller.toggle()
    expect(busy.deps.command).not.toHaveBeenCalled()
    expect(busy.deps.notify.mock.lastCall![1]).toContain('Espere a fila terminar')
    expect(busy.deps.notify.mock.lastCall![2]).toEqual({ kind: 'live' })
  })

  it('pausar e retomar vão ao renderer', () => {
    const { controller, deps } = setup()
    controller.pause()
    controller.resume()
    expect(deps.command.mock.calls).toEqual([[{ action: 'pause' }], [{ action: 'resume' }]])
  })
})

describe('BackgroundController: aviso de gravação', () => {
  it('começou: notificação com as faixas, badge e relógio sem as pausas', () => {
    const { controller, deps, state, lastState } = setup()
    state('idle', false, null) // idle sem sessão: end() sem timer
    state('recording')
    controller.onStarted({ tracks: ['voce', 'outros'], test: false, title: 'R' })
    expect(deps.notify).toHaveBeenCalledWith('Gravando', 'Você + Outros', { kind: 'live' })
    expect(deps.badge).toHaveBeenLastCalledWith(true, 'Gravando')
    vi.advanceTimersByTime(3000)
    expect(lastState()).toMatchObject({ live: 'recording', elapsed: 3 })
    state('paused')
    vi.advanceTimersByTime(10_000)
    expect(lastState()).toMatchObject({ live: 'paused', elapsed: 3 })
    state('recording')
    vi.advanceTimersByTime(2000)
    expect(lastState().elapsed).toBe(5)
    state('idle', false, null)
    expect(deps.badge).toHaveBeenLastCalledWith(false, 'Gravando')
    const renders = deps.view.render.mock.calls.length
    vi.advanceTimersByTime(5000) // relógio parado fora da sessão
    expect(deps.view.render.mock.calls.length).toBe(renders)
  })

  it('só o microfone; janela em foco não notifica; teste não notifica', () => {
    const { controller, deps, state, lastState } = setup()
    state('recording')
    controller.onStarted({ tracks: ['voce'], test: false, title: 'R' })
    expect(deps.notify).toHaveBeenLastCalledWith('Gravando', 'Só Você', { kind: 'live' })
    state('recording', true)
    expect(lastState().elapsed).toBe(0)
    const focused = setup({ windowFocused: () => true })
    focused.controller.onStarted({ tracks: ['voce'], test: false, title: 'R' })
    focused.controller.onStarted({ tracks: ['voce'], test: true, title: 'T' })
    expect(focused.deps.notify).not.toHaveBeenCalled()
  })

  it('outros eventos do ao vivo não mudam a bandeja', () => {
    const { controller, deps } = setup()
    controller.onLiveEvent({ type: 'lag', seconds: 3 })
    expect(deps.view.render).not.toHaveBeenCalled()
  })

  it('reunião salva (janela escondida) ou com erro (sempre) notifica e abre o item', () => {
    const { controller, deps, state } = setup()
    state('recording')
    controller.onItem(meta({ status: 'processing' })) // ainda gravando: nada
    controller.onItem(meta({ id: 'outro' }))
    expect(deps.notify).not.toHaveBeenCalled()
    controller.onItem(meta({}))
    expect(deps.notify).toHaveBeenCalledWith('Reunião salva', 'Reunião 26/09 — 12 min', {
      kind: 'item',
      id: 'item1'
    })
    controller.onItem(meta({})) // só uma vez por sessão
    expect(deps.notify).toHaveBeenCalledTimes(1)

    const failed = setup({ windowFocused: () => true })
    failed.state('recording')
    failed.controller.onItem(meta({ status: 'failed', duration: null }))
    expect(failed.deps.notify).toHaveBeenCalledWith(
      'A gravação terminou com erro',
      'Reunião 26/09',
      { kind: 'item', id: 'item1' }
    )
  })

  it('salva com a janela em foco não notifica; menos de 1 min vira 1 min', () => {
    const focused = setup({ windowFocused: () => true })
    focused.state('recording')
    focused.controller.onItem(meta({}))
    expect(focused.deps.notify).not.toHaveBeenCalled()
    const short = setup()
    short.state('recording')
    short.controller.onItem(meta({ duration: 10 }))
    expect(short.deps.notify.mock.lastCall![1]).toBe('Reunião 26/09 — 1 min')
    const unknown = setup()
    unknown.state('recording')
    unknown.controller.onItem(meta({ duration: null }))
    expect(unknown.deps.notify.mock.lastCall![1]).toBe('Reunião 26/09 — 1 min')
  })
})

describe('BackgroundController: relatos do renderer, janela e IA', () => {
  it('falha ao começar e microfone perdido viram notificação', () => {
    const { controller, deps } = setup()
    controller.report({ kind: 'startFailed', error: { code: 'MIC_DENIED', message: 'x' } })
    expect(deps.notify).toHaveBeenLastCalledWith(
      'Não deu para começar a gravar',
      'O acesso ao microfone foi negado.',
      { kind: 'live' }
    )
    controller.report({ kind: 'deviceLost' })
    expect(deps.notify).toHaveBeenLastCalledWith('Microfone desconectado', 'Gravação em pausa.', {
      kind: 'live'
    })
  })

  it('1º esconder da janela: aviso uma vez só, com o atalho', async () => {
    const { controller, deps } = setup()
    controller.onWindowHidden()
    await Promise.resolve()
    controller.onWindowHidden()
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalledWith(
      'Continua na bandeja',
      'Use Ctrl+Alt+R para gravar. Para sair, use o ícone na bandeja.',
      { kind: 'window' }
    )
    const none = setup({ shortcut: () => null })
    none.controller.onWindowHidden()
    expect(none.deps.notify.mock.lastCall![1]).toBe('Para gravar ou sair, use o ícone na bandeja.')
  })

  it('falha ao gravar a marca do aviso vai para o log', async () => {
    const { controller, deps } = setup({
      flags: {
        get: () => ({ hiddenHintShown: false }),
        set: vi.fn(() => Promise.reject(new Error('disco')))
      }
    })
    controller.onWindowHidden()
    await Promise.resolve()
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('pedido de IA não visto até a janela aparecer', () => {
    const { controller, lastState } = setup()
    controller.markAiUnseen()
    expect(lastState().aiUnseen).toBe(true)
    controller.onWindowShown()
    expect(lastState().aiUnseen).toBe(false)
  })

  it('snapshot e refresh refletem atalho, modelo e plataforma', () => {
    const { controller, deps } = setup({ platform: 'darwin' })
    controller.refresh()
    expect(controller.snapshot()).toEqual({
      live: 'idle',
      test: false,
      elapsed: 0,
      ready: true,
      shortcut: 'CommandOrControl+Alt+R',
      aiUnseen: false,
      platform: 'darwin'
    })
    expect(deps.view.render).toHaveBeenCalledTimes(1)
  })
})

describe('BackgroundController: sair', () => {
  it('sem sessão: sai na hora', async () => {
    const { controller, deps } = setup()
    await controller.quit()
    expect(deps.live.stop).not.toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalled()
  })

  it('gravando: finaliza antes de sair', async () => {
    const { controller, deps, state } = setup()
    state('recording')
    await controller.quit()
    expect(deps.live.stop).toHaveBeenCalled()
    expect(deps.quit).toHaveBeenCalled()
  })

  it('parando: espera a finalização em andamento antes de sair', async () => {
    const { controller, deps, state } = setup()
    let release: () => void = () => undefined
    deps.live.stop.mockReturnValue(
      new Promise((resolve) => {
        release = () => {
          resolve(null)
        }
      })
    )
    state('stopping')
    const done = controller.quit()
    await Promise.resolve()
    expect(deps.quit).not.toHaveBeenCalled()
    release()
    await done
    expect(deps.live.stop).toHaveBeenCalledTimes(1)
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })

  it('sair duas vezes espera a mesma finalização', async () => {
    const { controller, deps, state } = setup()
    let release: () => void = () => undefined
    deps.live.stop.mockReturnValue(
      new Promise((resolve) => {
        release = () => {
          resolve(null)
        }
      })
    )
    state('recording')
    const first = controller.quit()
    const second = controller.quit()
    expect(second).toBe(first)
    expect(deps.live.stop).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })

  it('finalização travada: sai depois do limite; falha vai para o log', async () => {
    const stuck = setup()
    stuck.live.stop.mockReturnValue(new Promise(() => undefined))
    stuck.state('paused')
    const done = stuck.controller.quit()
    await vi.advanceTimersByTimeAsync(QUIT_TIMEOUT_MS)
    await done
    expect(stuck.deps.quit).toHaveBeenCalled()

    const broken = setup()
    broken.live.stop.mockRejectedValue(new Error('disco'))
    broken.state('recording')
    await broken.controller.quit()
    expect(broken.deps.logger.error).toHaveBeenCalled()
    expect(broken.deps.quit).toHaveBeenCalled()
  })
})

describe('BackgroundController: pedidos das IAs (MCP)', () => {
  const job = (patch: Partial<HistoryMeta>) =>
    ({
      id: 'ai1',
      fileName: 'aula.mp4',
      status: 'queued',
      duration: null,
      requestedBy: 'claude-code',
      ...patch
    }) as HistoryMeta

  it('pedido: notifica com o nome da IA e acende o ponto azul; concluído notifica de novo', () => {
    const { controller, deps, lastState } = setup()
    controller.onQueueEvent({ type: 'job', meta: job({}) })
    expect(deps.notify).toHaveBeenLastCalledWith('Claude Code pediu uma transcrição', 'aula.mp4', {
      kind: 'item',
      id: 'ai1'
    })
    expect(lastState().aiUnseen).toBe(true)
    controller.onQueueEvent({ type: 'job', meta: job({}) }) // o mesmo item de novo: nada
    controller.onQueueEvent({ type: 'job', meta: job({ status: 'processing' }) })
    expect(deps.notify).toHaveBeenCalledTimes(1)
    controller.onQueueEvent({ type: 'job', meta: job({ status: 'done', duration: 725 }) })
    expect(deps.notify).toHaveBeenLastCalledWith(
      'Transcrição pronta (Claude Code)',
      'aula.mp4 — 12 min',
      { kind: 'item', id: 'ai1' }
    )
    controller.onQueueEvent({ type: 'job', meta: job({ status: 'done', duration: 725 }) })
    expect(deps.notify).toHaveBeenCalledTimes(2)
  })

  it('falha notifica o motivo; cancelado não notifica', () => {
    const { controller, deps } = setup()
    controller.onQueueEvent({ type: 'job', meta: job({}) })
    controller.onQueueEvent({
      type: 'job',
      meta: job({ status: 'failed', error: { code: 'NO_AUDIO', message: 'x' } })
    })
    expect(deps.notify.mock.lastCall![0]).toBe('A transcrição falhou (Claude Code)')
    expect(deps.notify.mock.lastCall![1]).toMatch(/^aula\.mp4: /)
    controller.onQueueEvent({ type: 'job', meta: job({ id: 'ai2' }) })
    controller.onQueueEvent({ type: 'job', meta: job({ id: 'ai2', status: 'canceled' }) })
    controller.onQueueEvent({ type: 'job', meta: job({ id: 'ai2', status: 'done' }) })
    expect(deps.notify).toHaveBeenCalledTimes(3)
  })

  it('concluído sem duração conhecida mostra 1 min', () => {
    const { controller, deps } = setup()
    controller.onQueueEvent({ type: 'job', meta: job({}) })
    controller.onQueueEvent({ type: 'job', meta: job({ status: 'done', duration: null }) })
    expect(deps.notify.mock.lastCall![1]).toBe('aula.mp4 — 1 min')
  })

  it('falha sem erro registrado usa o erro interno', () => {
    const { controller, deps } = setup()
    controller.onQueueEvent({ type: 'job', meta: job({}) })
    controller.onQueueEvent({ type: 'job', meta: job({ status: 'failed' }) })
    expect(deps.notify.mock.lastCall![1]).toMatch(/^aula\.mp4: ./)
  })

  it('arquivos da própria pessoa e outros eventos da fila: nada', () => {
    const { controller, deps } = setup()
    controller.onQueueEvent({ type: 'job', meta: job({ requestedBy: undefined }) })
    controller.onQueueEvent({ type: 'removed', jobId: 'ai1' })
    expect(deps.notify).not.toHaveBeenCalled()
    expect(deps.view.render).not.toHaveBeenCalled()
  })

  it('aviso desligado: sem notificação e sem ponto; janela em foco: notifica sem ponto', () => {
    const off = setup({ notifyAi: () => false })
    off.controller.onQueueEvent({ type: 'job', meta: job({}) })
    off.controller.onQueueEvent({ type: 'job', meta: job({ status: 'done' }) })
    expect(off.deps.notify).not.toHaveBeenCalled()
    expect(off.deps.view.render).not.toHaveBeenCalled()
    const focused = setup({ windowFocused: () => true })
    focused.controller.onQueueEvent({ type: 'job', meta: job({}) })
    expect(focused.deps.notify).toHaveBeenCalledTimes(1)
    expect(focused.deps.view.render).not.toHaveBeenCalled()
  })
})

describe('BackgroundController: relógio', () => {
  it('"gravando" repetido na mesma sessão não cria outro relógio nem zera o tempo', () => {
    const { deps, state, lastState } = setup()
    state('recording')
    vi.advanceTimersByTime(3000)
    state('recording')
    vi.advanceTimersByTime(1000)
    expect(lastState().elapsed).toBe(4)
    state('idle', false, null)
    const renders = deps.view.render.mock.calls.length
    vi.advanceTimersByTime(5000)
    expect(deps.view.render.mock.calls.length).toBe(renders)
  })
})
