import { act, createEvent, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MainScreen } from '../../../src/renderer/src/screens/main/MainScreen'
import { FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

function drop(
  target: Window,
  type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop',
  files: File[] = []
) {
  const event = createEvent[type](target)
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  fireEvent(target, event)
  return event
}

describe('MainScreen', () => {
  it('estado vazio: área de soltar, botão de escolher e formatos aceitos', async () => {
    const api = new FakeApi()
    api.files.choose.mockResolvedValue(['/v/a.mp4'])
    const { user, container } = await renderWithApp(<MainScreen />, { api })
    expect(screen.getByText('Solte vídeos ou áudios aqui')).toBeInTheDocument()
    expect(screen.getByText(/Vídeo: mp4, mkv, mov, avi, webm · Áudio: mp3/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Escolher vídeo ou áudio' }))
    expect(api.queue.enqueue).toHaveBeenCalledWith(['/v/a.mp4'])
    expect(screen.getByText('Selecione um item na barra lateral.')).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('arrastar mostra a camada de soltar; soltar enfileira e avisa os recusados', async () => {
    const api = new FakeApi()
    api.queue.enqueue.mockResolvedValue({ accepted: [], rejected: ['/soltos/nota.pdf'] })
    const { store } = await renderWithApp(<MainScreen />, { api })
    drop(window, 'dragEnter')
    expect(screen.getByText('Solte para transcrever')).toBeInTheDocument()
    expect(drop(window, 'dragOver').defaultPrevented).toBe(true)
    drop(window, 'dragEnter') // passou sobre um elemento filho
    drop(window, 'dragLeave')
    expect(screen.getByText('Solte para transcrever')).toBeInTheDocument()
    drop(window, 'dragLeave')
    expect(screen.queryByText('Solte para transcrever')).not.toBeInTheDocument()
    drop(window, 'dragEnter')
    await act(async () => {
      drop(window, 'drop', [new File(['x'], 'aula.mp4'), new File(['y'], 'nota.pdf')])
      await Promise.resolve()
    })
    expect(api.queue.enqueue).toHaveBeenCalledWith(['/soltos/aula.mp4', '/soltos/nota.pdf'])
    expect(screen.queryByText('Solte para transcrever')).not.toBeInTheDocument()
    await vi.waitFor(() => {
      expect(store.getState().notices).toMatchObject([
        { key: 'notices.rejected', values: { names: 'nota.pdf' } }
      ])
    })
  })

  it('arrastar algo que não é arquivo (texto) é ignorado; soltar sem arquivos não enfileira', async () => {
    const { api } = await renderWithApp(<MainScreen />)
    const event = createEvent.dragEnter(window)
    Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['text/plain'] } })
    fireEvent(window, event)
    expect(screen.queryByText('Solte para transcrever')).not.toBeInTheDocument()
    fireEvent(window, createEvent.dragEnter(window)) // sem dataTransfer
    expect(screen.queryByText('Solte para transcrever')).not.toBeInTheDocument()
    const empty = createEvent.drop(window)
    fireEvent(window, empty)
    expect(api.queue.enqueue).not.toHaveBeenCalled()
  })

  it('selecionar um item carrega o detalhe: player e trechos', async () => {
    const meta = makeMeta({ fileName: 'aula.mp4', status: 'interrupted' })
    const api = new FakeApi()
    api.entries = [meta]
    api.details.set(meta.id, {
      meta,
      transcript: [{ inicio: 0, fim: 1, texto: 'recuperado' }],
      videoAvailable: true
    })
    const { user } = await renderWithApp(<MainScreen />, { api })
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: /^aula\.mp4/ })
    )
    expect(await screen.findByRole('heading', { name: 'aula.mp4' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /recuperado/ })).toBeInTheDocument()
  })

  it('detalhe que falha ao carregar não derruba a tela', async () => {
    const meta = makeMeta({ fileName: 'x.mp4', status: 'interrupted' })
    const api = new FakeApi()
    api.entries = [meta]
    api.history.get.mockRejectedValue(new Error('corrompido'))
    const { user } = await renderWithApp(<MainScreen />, { api })
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: /^x\.mp4/ })
    )
    expect(await screen.findByRole('heading', { name: 'x.mp4' })).toBeInTheDocument()
  })

  it('trocar de item antes do detalhe chegar ignora a resposta velha', async () => {
    const a = makeMeta({ fileName: 'a.mp4', status: 'interrupted' })
    const b = makeMeta({ fileName: 'b.mp4', status: 'interrupted' })
    const api = new FakeApi()
    api.entries = [a, b]
    let release: () => void = () => undefined
    api.history.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({
              meta: a,
              transcript: [{ inicio: 0, fim: 1, texto: 'velho' }],
              videoAvailable: true
            })
          }
        })
    )
    const { user } = await renderWithApp(<MainScreen />, { api })
    const nav = within(screen.getByRole('navigation'))
    await user.click(nav.getByRole('button', { name: /^a\.mp4/ }))
    await user.click(nav.getByRole('button', { name: /^b\.mp4/ }))
    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(screen.queryByText('velho')).not.toBeInTheDocument()
  })

  it('item concluído mostra o resultado em abas no lugar do chat', async () => {
    const meta = makeMeta({ fileName: 'pronto.mp4' })
    const api = new FakeApi()
    api.entries = [meta]
    api.details.set(meta.id, {
      meta,
      transcript: [{ inicio: 0, fim: 1, texto: 'fim.' }],
      videoAvailable: true
    })
    const { user } = await renderWithApp(<MainScreen />, { api })
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: /^pronto\.mp4/ })
    )
    expect(await screen.findByRole('tab', { name: 'Trechos' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(await screen.findByRole('button', { name: '00:00 fim.' })).toBeInTheDocument()
  })

  it('o player recarrega quando o job termina (o áudio só existe depois da extração)', async () => {
    const job = makeMeta({ fileName: 'nota.mp3', mediaKind: 'audio', status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    const { container } = await renderWithApp(<MainScreen />, { api })
    const before = container.querySelector('audio')!
    fireEvent.error(before)
    expect(screen.getByText('A mídia ainda não está disponível.')).toBeInTheDocument()
    act(() => {
      api.emitQueue({ type: 'job', meta: { ...job, status: 'done' } })
    })
    expect(container.querySelector('audio')).not.toBe(before)
    expect(screen.queryByText('A mídia ainda não está disponível.')).not.toBeInTheDocument()
  })
})
