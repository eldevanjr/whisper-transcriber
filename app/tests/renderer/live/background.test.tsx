import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { useLiveController } from '../../../src/renderer/src/live/LiveCaptureProvider'
import { AppError } from '../../../src/shared/errors'
import { FakeApi, makeMeta } from '../fake-api'
import { FakeLiveMedia } from '../fake-media'
import { renderWithApp } from '../render'

async function ready(options: { api?: FakeApi; media?: FakeLiveMedia } = {}) {
  const api = options.api ?? new FakeApi()
  api.settingsValue = { ...api.settingsValue, model: 'medium' }
  const rendered = await renderWithApp(<App />, { ...options, api })
  await screen.findByRole('button', { name: 'Ao vivo' })
  return rendered
}

function UsesController() {
  useLiveController()
  return null
}

describe('ao vivo pela bandeja', () => {
  it('na tela principal o microfone fica fechado', async () => {
    const { media } = await ready()
    expect(media.start).not.toHaveBeenCalled()
  })

  it('toggle abre a tela, começa com as configurações salvas e para', async () => {
    const { api, media, store } = await ready()
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.live.start).toHaveBeenCalledWith(
        expect.objectContaining({ test: false, tracks: ['voce', 'outros'] })
      )
    })
    expect(store.getState().view).toBe('live')
    const item = makeMeta({ kind: 'live' })
    api.live.stop.mockResolvedValueOnce(item)
    act(() => {
      api.emitLive({ type: 'state', state: 'recording', test: false, itemId: item.id })
    })
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.live.stop).toHaveBeenCalled()
    })
    act(() => {
      api.emitLive({ type: 'state', state: 'idle', test: false, itemId: null })
    })
    // Parar volta para a tela principal no item: a captura fecha (o microfone apaga).
    await waitFor(() => {
      expect(store.getState().view).toBe('main')
    })
    expect(store.getState().selectedId).toBe(item.id)
    await waitFor(() => {
      expect(media.last.stopped).toBe(true)
    })
  })

  it('pausar e retomar pela bandeja; retomar com microfone perdido é ignorado', async () => {
    const { api, media } = await ready()
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.live.start).toHaveBeenCalled()
    })
    act(() => {
      api.emitLive({ type: 'state', state: 'recording', test: false, itemId: 'i' })
      api.emitCommand({ action: 'resume' }) // não está em pausa: nada
    })
    act(() => {
      api.emitCommand({ action: 'pause' })
    })
    expect(api.live.pause).toHaveBeenCalledTimes(1)
    act(() => {
      api.emitLive({ type: 'state', state: 'paused', test: false, itemId: 'i' })
      api.emitCommand({ action: 'pause' }) // já em pausa: nada
    })
    act(() => {
      api.emitCommand({ action: 'resume' })
    })
    expect(api.live.pause).toHaveBeenCalledTimes(1)
    expect(api.live.resume).toHaveBeenCalledTimes(1)
    // Perdeu o microfone e retomou no mesmo lote: o guard (ref) ignora a retomada.
    act(() => {
      media.last.emit({ type: 'device-lost', track: 'voce' })
      api.emitCommand({ action: 'resume' })
    })
    expect(api.live.resume).toHaveBeenCalledTimes(1)
  })

  it('microfone negado: relata ao main (que notifica)', async () => {
    const media = new FakeLiveMedia()
    media.failure = new AppError('MIC_DENIED', 'negado')
    const { api } = await ready({ media })
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.background.report).toHaveBeenCalledWith({
        kind: 'startFailed',
        error: expect.objectContaining({ code: 'MIC_DENIED' }) as unknown
      })
    })
    expect(api.live.start).not.toHaveBeenCalled()
  })

  it('start recusado pelo main (fila ocupada): relata', async () => {
    const api = new FakeApi()
    api.live.start.mockRejectedValueOnce({ code: 'QUEUE_BUSY', message: 'ocupada' })
    await ready({ api })
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.background.report).toHaveBeenCalledWith({
        kind: 'startFailed',
        error: expect.objectContaining({ code: 'QUEUE_BUSY' }) as unknown
      })
    })
  })

  it('toggle durante começando/parando é ignorado; durante o teste da tela, para o teste', async () => {
    const { api, store } = await ready()
    act(() => {
      api.emitLive({ type: 'state', state: 'starting', test: false, itemId: null })
      api.emitCommand({ action: 'toggle' })
    })
    expect(store.getState().view).toBe('main')
    act(() => {
      api.emitLive({ type: 'state', state: 'recording', test: true, itemId: null })
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.live.stop).toHaveBeenCalled()
    })
  })

  it('microfone desconectado durante a sessão: relata', async () => {
    const { api, media } = await ready()
    act(() => {
      api.emitCommand({ action: 'toggle' })
    })
    await waitFor(() => {
      expect(api.live.start).toHaveBeenCalled()
    })
    act(() => {
      media.last.emit({ type: 'device-lost', track: 'voce' })
    })
    await waitFor(() => {
      expect(api.background.report).toHaveBeenCalledWith({ kind: 'deviceLost' })
    })
  })
})

describe('navegação pedida pelo main (clique em notificação)', () => {
  it('item: seleciona e volta à tela principal; ao vivo: abre a tela', async () => {
    const { api, store } = await ready()
    act(() => {
      api.emitNavigate({ kind: 'live' })
    })
    expect(store.getState().view).toBe('live')
    act(() => {
      api.emitNavigate({ kind: 'item', id: 'x' })
    })
    expect(store.getState()).toMatchObject({ view: 'main', selectedId: 'x' })
    act(() => {
      api.emitNavigate({ kind: 'window' })
    })
    expect(store.getState().view).toBe('main')
  })

  it('com sessão em andamento, abrir um item não fecha a tela da sessão', async () => {
    const { api, store } = await ready()
    act(() => {
      store.getState().openLive()
      api.emitLive({ type: 'state', state: 'recording', test: false, itemId: 'i' })
      api.emitNavigate({ kind: 'item', id: 'x' })
    })
    expect(store.getState()).toMatchObject({ view: 'live', selectedId: 'x' })
  })
})

describe('useLiveController', () => {
  it('fora do LiveCaptureProvider avisa claramente', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined) // o React loga o erro
    expect(() => render(<UsesController />)).toThrow('fora do LiveCaptureProvider')
  })
})
