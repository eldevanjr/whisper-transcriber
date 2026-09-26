import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LiveScreen } from '../../../src/renderer/src/screens/live/LiveScreen'
import { AppError } from '../../../src/shared/errors'
import { APP_INFO, FakeApi, makeMeta } from '../fake-api'
import { FakeLiveMedia } from '../fake-media'
import { expectAccessible, renderWithApp } from '../render'

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

async function open(options: { api?: FakeApi; media?: FakeLiveMedia } = {}) {
  const media = options.media ?? new FakeLiveMedia()
  const rendered = await renderWithApp(<LiveScreen />, { ...options, media })
  act(() => {
    rendered.store.getState().openLive()
  })
  await waitFor(() => {
    expect(media.start).toHaveBeenCalled()
  })
  await act(async () => {
    await Promise.resolve() // deixa a captura montar os avisos antes de mexer nos timers
  })
  return rendered
}

function meter(name: string): number {
  return Number(screen.getByRole('meter', { name: `Nível: ${name}` }).getAttribute('aria-valuenow'))
}

async function startSession(test = false) {
  const rendered = await open()
  const { api, user } = rendered
  await user.click(screen.getByRole('button', { name: test ? 'Testar' : 'Iniciar' }))
  act(() => {
    api.emitLive({ type: 'state', state: 'recording', test, itemId: test ? null : 'i1' })
  })
  return rendered
}

describe('Ao vivo — preparar e testar', () => {
  it('abre microfone e áudio do computador com as configurações; medidores seguem o nível', async () => {
    const { media, container } = await open()
    expect(media.start).toHaveBeenLastCalledWith({
      micDeviceId: null,
      systemAudio: true,
      support: 'monitor'
    })
    expect(meter('Você')).toBe(0)
    act(() => {
      media.last.block('voce', 0, 0.5)
      media.last.block('outros', 0, 0.01)
    })
    expect(meter('Você')).toBeGreaterThan(80)
    expect(meter('Outros')).toBeGreaterThan(0)
    expect(meter('Outros')).toBeLessThan(meter('Você'))
    await expectAccessible(container)
  })

  it('lista os microfones (sem monitores nem o "default" duplicado) e salva a escolha', async () => {
    const media = new FakeLiveMedia()
    media.inputs = [
      { id: 'default', label: 'Default', monitor: false },
      { id: 'mic1', label: 'Microfone USB', monitor: false },
      { id: 'x', label: '', monitor: false },
      { id: 'mon', label: 'Monitor of Alto-falantes', monitor: true }
    ]
    const { api, user } = await open({ media })
    const select = screen.getByLabelText('Microfone')
    await waitFor(() => {
      expect(
        within(select)
          .getAllByRole('option')
          .map((o) => o.textContent)
      ).toEqual(['Padrão do sistema', 'Microfone USB', 'Microfone 2'])
    })
    await user.selectOptions(select, 'mic1')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: 'mic1', systemAudio: true, pauseS: 1 }
    })
    await waitFor(() => {
      expect(media.start).toHaveBeenLastCalledWith(expect.objectContaining({ micDeviceId: 'mic1' }))
    })
    expect(media.captures[0]!.stopped).toBe(true) // a captura anterior foi solta
    await user.selectOptions(select, '')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: null, systemAudio: true, pauseS: 1 }
    })
  })

  it('áudio do computador e pausa salvam nas configurações', async () => {
    const { api, user } = await open()
    await user.click(screen.getByRole('switch', { name: 'Áudio do computador (Outros)' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: null, systemAudio: false, pauseS: 1 }
    })
    const slider = screen.getByRole('slider', { name: 'Pausa que fecha uma frase' })
    fireEvent.change(slider, { target: { value: '1.1' } }) // o user-event não arrasta sliders
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: null, systemAudio: false, pauseS: 1.1 }
    })
    expect(screen.getByText('1,1 s')).toBeInTheDocument()
  })

  it('sistema sem áudio do computador: opção desligada com o motivo', async () => {
    const api = new FakeApi()
    api.live.capabilities.mockResolvedValue({ systemAudio: 'unavailable' })
    const { media } = await open({ api })
    const toggle = screen.getByRole('switch', { name: 'Áudio do computador (Outros)' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('Não disponível neste sistema.')).toBeInTheDocument()
    expect(media.last.options.support).toBe('unavailable')
    expect(screen.queryByRole('meter', { name: 'Nível: Outros' })).not.toBeInTheDocument()
  })

  it('áudio do computador pedido mas não capturado: avisa que segue só com o microfone', async () => {
    const media = new FakeLiveMedia()
    media.systemWorks = false
    await open({ media })
    expect(await screen.findByText(/segue só com o microfone/)).toBeInTheDocument()
  })

  it('microfone negado no macOS: explica e abre as permissões do sistema', async () => {
    const api = new FakeApi()
    api.app.info.mockResolvedValue({ ...APP_INFO, platform: 'darwin' })
    const media = new FakeLiveMedia()
    media.failure = new AppError('MIC_DENIED', 'negado')
    const { user } = await open({ api, media })
    expect(await screen.findByText('O acesso ao microfone foi negado.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Abrir as permissões do sistema' }))
    expect(api.system.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    media.failure = null
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => {
      expect(screen.queryByText('O acesso ao microfone foi negado.')).not.toBeInTheDocument()
    })
    expect(media.start).toHaveBeenCalledTimes(2)
  })

  it('no Linux não há página de permissões para abrir', async () => {
    const media = new FakeLiveMedia()
    media.failure = new AppError('MIC_DENIED', 'negado')
    await open({ media })
    await screen.findByText('O acesso ao microfone foi negado.')
    expect(
      screen.queryByRole('button', { name: 'Abrir as permissões do sistema' })
    ).not.toBeInTheDocument()
  })

  it('outra falha da captura: só "Tentar de novo"', async () => {
    const api = new FakeApi()
    api.app.info.mockResolvedValue({ ...APP_INFO, platform: 'win32' })
    const media = new FakeLiveMedia()
    media.failure = new DOMException('sem dispositivo', 'NotFoundError')
    await open({ api, media })
    expect(await screen.findByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Abrir as permissões do sistema' })
    ).not.toBeInTheDocument()
  })

  it('microfone desconectado antes de começar: avisa sem pausar sessão nenhuma', async () => {
    const { api, media } = await open()
    act(() => {
      media.last.emit({ type: 'device-lost', track: 'voce' })
    })
    expect(api.live.pause).not.toHaveBeenCalled()
    expect(meter('Você')).toBe(0)
  })

  it('antes de o estado carregar usa os padrões e não quebra', async () => {
    const media = new FakeLiveMedia()
    media.failure = new AppError('MIC_DENIED', 'negado')
    const rendered = await renderWithApp(<LiveScreen />, { media, init: false })
    act(() => {
      rendered.store.getState().openLive()
    })
    expect(await screen.findByText('O acesso ao microfone foi negado.')).toBeInTheDocument()
    expect(screen.getByText('1,0 s')).toBeInTheDocument()
  })

  it('sair antes de a captura abrir solta o microfone quando ele chega', async () => {
    const media = new FakeLiveMedia()
    const real = media.start.getMockImplementation()!
    let release = (): void => undefined
    media.start.mockImplementation(
      (options) =>
        new Promise((resolve) => {
          release = () => {
            resolve(real(options))
          }
        })
    )
    const rendered = await renderWithApp(<LiveScreen />, { media })
    act(() => {
      rendered.store.getState().openLive()
    })
    await waitFor(() => {
      expect(media.start).toHaveBeenCalled()
    })
    rendered.unmount()
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(media.last.stopped).toBe(true)
    })
  })

  it('respostas que chegam depois de sair da tela são ignoradas', async () => {
    const api = new FakeApi()
    const media = new FakeLiveMedia()
    const support = deferred<{ systemAudio: 'monitor' }>()
    const devices = deferred<[]>()
    api.live.capabilities.mockReturnValueOnce(support.promise)
    media.devices.mockReturnValueOnce(devices.promise)
    const first = await renderWithApp(<LiveScreen />, { api, media })
    act(() => {
      first.store.getState().openLive()
    })
    first.unmount()
    await act(async () => {
      support.resolve({ systemAudio: 'monitor' })
      devices.resolve([])
      await support.promise
    })
    expect(media.start).not.toHaveBeenCalled()

    const failure = deferred<never>()
    media.start.mockReturnValueOnce(failure.promise)
    const second = await renderWithApp(<LiveScreen />, { api, media })
    act(() => {
      second.store.getState().openLive()
    })
    await waitFor(() => {
      expect(media.start).toHaveBeenCalled()
    })
    second.unmount()
    await act(async () => {
      failure.reject(new AppError('MIC_DENIED', 'negado'))
      await failure.promise.catch(() => undefined)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('"Testar" transcreve na tela sem criar item; os blocos só vão depois de começar', async () => {
    const { api, media, store, user } = await open()
    act(() => {
      media.last.block('voce', 0, 0.2)
    })
    expect(api.live.sendAudio).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Testar' }))
    expect(api.live.start).toHaveBeenCalledWith({
      tracks: ['voce', 'outros'],
      test: true,
      title: expect.stringMatching(/^Reunião \d\d\/\d\d/) as string
    })
    let pcm: Int16Array = new Int16Array()
    act(() => {
      api.emitLive({ type: 'state', state: 'recording', test: true, itemId: null })
      pcm = media.last.block('voce', 1, 0.2)
      api.emitLive({ type: 'segment', track: 'voce', start: 0, end: 1.2, text: 'Testando um dois' })
    })
    expect(api.live.sendAudio).toHaveBeenCalledWith('voce', 1, pcm)
    expect(screen.getByText('Testando um dois')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Parar o teste' }))
    expect(api.live.stop).toHaveBeenCalled()
    act(() => {
      api.emitLive({ type: 'state', state: 'idle', test: true, itemId: null })
    })
    expect(store.getState().view).toBe('live') // continua preparando
    expect(screen.getByText('Testando um dois')).toBeInTheDocument()
    expect(media.last.stopped).toBe(false)
  })

  it('"Iniciar" fica desabilitado com a fila ocupada, com o motivo', async () => {
    const api = new FakeApi()
    const job = makeMeta({ status: 'processing' })
    api.entries = [job]
    api.current = job.id
    await open({ api })
    expect(screen.getByRole('button', { name: 'Iniciar' })).toBeDisabled()
    expect(screen.getByText(/Espere a transcrição da fila terminar/)).toBeInTheDocument()
  })

  it('falha ao começar vira aviso e a tela continua preparando', async () => {
    const api = new FakeApi()
    api.live.start.mockRejectedValueOnce({ code: 'QUEUE_BUSY', message: 'ocupada' })
    const { store, user } = await open({ api })
    await user.click(screen.getByRole('button', { name: 'Iniciar' }))
    expect(store.getState().notices).toMatchObject([{ key: 'errors.QUEUE_BUSY' }])
    expect(screen.getByRole('button', { name: 'Iniciar' })).toBeEnabled()
  })

  it('"Voltar" fecha a tela e solta o microfone', async () => {
    const { media, store, user, unmount } = await open()
    await user.click(screen.getByRole('button', { name: 'Voltar' }))
    expect(store.getState().view).toBe('main')
    unmount()
    expect(media.last.stopped).toBe(true)
  })
})

describe('Ao vivo — sessão', () => {
  it('conversa em balões: Você à direita, Outros à esquerda, com o tempo; "ouvindo"', async () => {
    const { api, container } = await startSession()
    expect(screen.getByText('REC')).toBeInTheDocument()
    act(() => {
      api.emitLive({ type: 'segment', track: 'outros', start: 2, end: 4, text: 'Bom dia a todos' })
      api.emitLive({ type: 'segment', track: 'voce', start: 65, end: 67, text: 'Bom dia' })
      api.emitLive({ type: 'listening', track: 'outros', active: true })
      api.emitLive({ type: 'listening', track: 'voce', active: true })
    })
    const log = screen.getByRole('log', { name: 'Conversa' })
    const [others, you] = within(log).getAllByRole('listitem')
    expect(others).toHaveTextContent('Outros · 00:02Bom dia a todos')
    expect(others).toHaveClass('self-start')
    expect(you).toHaveTextContent('Você · 01:05Bom dia')
    expect(you).toHaveClass('self-end')
    expect(screen.getByText('ouvindo (Outros)').closest('li')).toHaveClass('self-start')
    expect(screen.getByText('ouvindo (Você)').closest('li')).toHaveClass('self-end')
    await expectAccessible(container)
  })

  it('aviso de atraso só a partir de 3 s; acima de 2 min sugere GPU ou modelo menor', async () => {
    const { api } = await startSession()
    act(() => {
      api.emitLive({ type: 'lag', seconds: 2 })
    })
    expect(screen.queryByText(/atrás da fala/)).not.toBeInTheDocument()
    act(() => {
      api.emitLive({ type: 'lag', seconds: 3 })
    })
    expect(screen.getByText('Transcrição 3 s atrás da fala')).toBeInTheDocument()
    expect(screen.queryByText(/modelo menor/)).not.toBeInTheDocument()
    act(() => {
      api.emitLive({ type: 'lag', seconds: 121 })
    })
    expect(screen.getByText(/modelo menor/)).toBeInTheDocument()
  })

  it('Pausar para de enviar; Retomar volta; Encerrar abre o item no histórico', async () => {
    const { api, media, store, user } = await startSession()
    await user.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(api.live.pause).toHaveBeenCalled()
    act(() => {
      api.emitLive({ type: 'state', state: 'paused', test: false, itemId: 'i1' })
      media.last.block('voce', 5, 0.3)
    })
    expect(api.live.sendAudio).not.toHaveBeenCalled()
    expect(screen.getByText('Pausado')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retomar' }))
    expect(api.live.resume).toHaveBeenCalled()
    act(() => {
      api.emitLive({ type: 'state', state: 'recording', test: false, itemId: 'i1' })
      media.last.block('voce', 6, 0.3)
    })
    expect(api.live.sendAudio).toHaveBeenCalledTimes(1)
    const item = makeMeta({ kind: 'live', fileName: 'Reunião' })
    api.live.stop.mockResolvedValueOnce(item)
    await user.click(screen.getByRole('button', { name: 'Encerrar' }))
    expect(store.getState()).toMatchObject({ view: 'main', selectedId: item.id })
  })

  it('encerrando: botões desabilitados', async () => {
    const { api } = await startSession()
    act(() => {
      api.emitLive({ type: 'state', state: 'stopping', test: false, itemId: 'i1' })
    })
    expect(screen.getByRole('button', { name: 'Encerrando…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled()
  })

  it('microfone desconectado: pausa, avisa e reconecta com o dispositivo escolhido', async () => {
    const { api, media, user } = await startSession()
    act(() => {
      media.last.emit({ type: 'device-lost', track: 'voce' })
    })
    expect(api.live.pause).toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('O microfone foi desconectado')
    await within(alert).findByRole('option', { name: 'Microfone USB' })
    await user.selectOptions(within(alert).getByLabelText('Microfone'), 'mic1')
    await waitFor(() => {
      expect(media.start).toHaveBeenLastCalledWith(expect.objectContaining({ micDeviceId: 'mic1' }))
    })
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('"Reconectar" reabre o mesmo microfone', async () => {
    const { media, user } = await startSession()
    act(() => {
      media.last.emit({ type: 'device-lost', track: 'voce' })
    })
    await user.click(screen.getByRole('button', { name: 'Reconectar' }))
    await waitFor(() => {
      expect(media.start).toHaveBeenCalledTimes(2)
    })
  })

  it('tempo de gravação corre só gravando', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { api } = await startSession()
      expect(screen.getByRole('timer')).toHaveTextContent('00:00')
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole('timer')).toHaveTextContent('00:02')
      act(() => {
        api.emitLive({ type: 'state', state: 'paused', test: false, itemId: 'i1' })
      })
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(screen.getByRole('timer')).toHaveTextContent('00:02')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sair da tela no meio da sessão encerra a sessão', async () => {
    const { api, unmount } = await startSession()
    unmount()
    expect(api.live.stop).toHaveBeenCalled()
  })
})

describe('Ao vivo — volume de captura do áudio do computador', () => {
  it('avisa na preparação quando os Outros vão chegar mudos e corrige com um clique', async () => {
    const api = new FakeApi()
    api.live.monitorVolume.mockResolvedValue({ sink: 'Fone USB', percent: 8, muted: true })
    const { user, container } = await open({ api })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('silenciado para gravação')
    expect(alert).toHaveTextContent('“Fone USB”')
    await expectAccessible(container)
    await user.click(within(alert).getByRole('button', { name: 'Ajustar para 100%' }))
    expect(api.live.setMonitorVolume).toHaveBeenCalledWith(100)
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('volume bom ou sem o áudio do computador: nenhum aviso', async () => {
    const api = new FakeApi()
    api.live.monitorVolume.mockResolvedValue({ sink: 'Fone USB', percent: 100, muted: false })
    await open({ api })
    await waitFor(() => {
      expect(api.live.monitorVolume).toHaveBeenCalled()
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('na sessão, avisa se outro programa baixar o volume no meio da conversa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { api } = await startSession()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      api.live.monitorVolume.mockResolvedValue({ sink: 'Fone USB', percent: 20, muted: false })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(await screen.findByRole('alert')).toHaveTextContent('quase mudo (20%)')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Ao vivo — áudio do computador sem sinal (todos os sistemas)', () => {
  const NO_SIGNAL = /Nenhum som do computador chegou nos primeiros 15 s/

  async function silentFor(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  it('avisa quando nada chega em 15 s e some quando o som chega', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { media, container } = await open()
      act(() => {
        media.last.block('outros', 0, 0.0001) // o quase mudo do monitor: conta como silêncio
      })
      await silentFor(14_000)
      expect(screen.queryByText(NO_SIGNAL)).not.toBeInTheDocument()
      await silentFor(1_000)
      expect(screen.getByText(NO_SIGNAL)).toBeInTheDocument()
      expect(screen.queryByText(/Gravação de tela/)).not.toBeInTheDocument() // só no macOS
      await expectAccessible(container)
      act(() => {
        media.last.block('outros', 1, 0.05)
      })
      expect(screen.queryByText(NO_SIGNAL)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('som logo no começo: silêncio depois é conversa normal, sem aviso', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { media } = await open()
      act(() => {
        media.last.block('outros', 0, 0.05)
      })
      act(() => {
        media.last.block('outros', 1, 0)
      })
      await silentFor(60_000)
      expect(screen.queryByText(NO_SIGNAL)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('no macOS lembra da permissão de Gravação de tela', async () => {
    const api = new FakeApi()
    api.app.info.mockResolvedValue({ ...APP_INFO, platform: 'darwin' })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await open({ api })
      await silentFor(15_000)
      expect(screen.getByText(NO_SIGNAL)).toBeInTheDocument()
      expect(screen.getByText(/permissão de Gravação de tela/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('com o volume do monitor baixo (Linux), só o aviso que explica e corrige', async () => {
    const api = new FakeApi()
    api.live.monitorVolume.mockResolvedValue({ sink: 'Fone USB', percent: 8, muted: false })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await open({ api })
      await silentFor(15_000)
      expect(screen.getByRole('alert')).toHaveTextContent('quase mudo (8%)')
      expect(screen.queryByText(NO_SIGNAL)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sem a faixa dos Outros aberta, nenhum aviso de sinal', async () => {
    const media = new FakeLiveMedia()
    media.systemWorks = false
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await open({ media })
      await silentFor(15_000)
      expect(screen.queryByText(NO_SIGNAL)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Ao vivo — outros idiomas', () => {
  it('em inglês', async () => {
    const media = new FakeLiveMedia()
    const { store } = await renderWithApp(<LiveScreen />, { media, language: 'en' })
    act(() => {
      store.getState().openLive()
    })
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument()
  })
})
