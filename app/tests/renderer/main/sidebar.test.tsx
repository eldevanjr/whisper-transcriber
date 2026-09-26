import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sidebar } from '../../../src/renderer/src/screens/main/Sidebar'
import { apiError, FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

function withEntries(...entries: ReturnType<typeof makeMeta>[]) {
  const api = new FakeApi()
  api.entries = entries
  return api
}

describe('Sidebar', () => {
  it('fila com o atual e os pendentes; histórico do mais novo para o mais antigo', async () => {
    const current = makeMeta({ fileName: 'atual.mp4', status: 'processing' })
    const waiting = makeMeta({ fileName: 'espera.mp3', status: 'queued' })
    const old = makeMeta({ fileName: 'antigo.mp4' })
    const recent = makeMeta({ fileName: 'recente.mp4' })
    const api = withEntries(old, recent, current, waiting)
    api.current = current.id
    api.pending = [waiting.id]
    const { container } = await renderWithApp(<Sidebar />, { api })
    const queue = screen.getByRole('region', { name: 'Fila (2)' })
    expect(
      within(queue)
        .getAllByRole('button', { name: /atual|espera/ })
        .map((b) => b.textContent)
    ).toEqual([expect.stringContaining('atual.mp4'), expect.stringContaining('espera.mp3')])
    const history = screen.getByRole('region', { name: 'Histórico' })
    const names = within(history)
      .getAllByText(/\.mp4$/)
      .map((element) => element.textContent)
    expect(names).toEqual(['recente.mp4', 'antigo.mp4'])
    await expectAccessible(container)
  })

  it('selo "via <IA>" na fila e no histórico; desconhecido mostra o nome cru; ausente não mostra', async () => {
    const current = makeMeta({
      fileName: 'atual.mp4',
      status: 'processing',
      requestedBy: 'claude-code'
    })
    const old = makeMeta({ fileName: 'antigo.mp4', requestedBy: 'minha-ia' })
    const plain = makeMeta({ fileName: 'app.mp4' })
    const api = withEntries(current, old, plain)
    api.current = current.id
    const { container } = await renderWithApp(<Sidebar />, { api })
    const queue = screen.getByRole('region', { name: 'Fila (1)' })
    expect(within(queue).getByText('via Claude Code')).toBeInTheDocument()
    const history = screen.getByRole('region', { name: 'Histórico' })
    expect(within(history).getByText('via minha-ia')).toBeInTheDocument()
    expect(within(history).queryByText(/^via /)).toBeInTheDocument()
    expect(screen.getAllByText(/^via /)).toHaveLength(2)
    await expectAccessible(container)
  })

  it('selecionar marca o item; remover tira da fila', async () => {
    const waiting = makeMeta({ fileName: 'espera.mp3', status: 'queued' })
    const api = withEntries(waiting)
    api.pending = [waiting.id]
    const { user, store } = await renderWithApp(<Sidebar />, { api })
    await user.click(screen.getByRole('button', { name: /espera\.mp3/ }))
    expect(store.getState().selectedId).toBe(waiting.id)
    expect(screen.getByRole('button', { name: /espera\.mp3/ })).toHaveAttribute(
      'aria-current',
      'true'
    )
    await user.click(screen.getByRole('button', { name: 'Remover da fila' }))
    expect(api.queue.remove).toHaveBeenCalledWith(waiting.id)
  })

  it('histórico vazio avisa; "Adicionar" escolhe arquivos e enfileira', async () => {
    const api = new FakeApi()
    api.files.choose.mockResolvedValue(['/v/a.mp4'])
    const { user } = await renderWithApp(<Sidebar />, { api })
    expect(screen.getByText('Nada por aqui ainda.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(api.queue.enqueue).toHaveBeenCalledWith(['/v/a.mp4'])
    api.files.choose.mockResolvedValue([]) // diálogo cancelado
    await user.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(api.queue.enqueue).toHaveBeenCalledTimes(1)
  })

  it('falhou/interrompido oferecem "Transcrever de novo"; excluir pede confirmação', async () => {
    const failed = makeMeta({
      fileName: 'ruim.mp4',
      status: 'failed',
      error: { code: 'INVALID_MEDIA', message: 'x' }
    })
    const done = makeMeta({ fileName: 'bom.mp4' })
    const api = withEntries(failed, done)
    const { user } = await renderWithApp(<Sidebar />, { api })
    await user.click(screen.getByRole('button', { name: 'Transcrever de novo: ruim.mp4' }))
    expect(api.queue.retry).toHaveBeenCalledWith(failed.id)
    await user.click(screen.getByRole('button', { name: 'Excluir: bom.mp4' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Excluir do histórico?' })
    expect(dialog).toHaveTextContent('"bom.mp4" será apagado')
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(api.history.remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Excluir: bom.mp4' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' })
    )
    expect(api.history.remove).toHaveBeenCalledWith(done.id)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('arquivo movido: localizar escolhe o novo arquivo e refaz', async () => {
    const moved = makeMeta({
      fileName: 'sumiu.mp4',
      status: 'failed',
      error: { code: 'FILE_NOT_FOUND', message: 'x' }
    })
    const api = withEntries(moved)
    api.files.choose.mockResolvedValue(['/novo/sumiu.mp4'])
    const { user } = await renderWithApp(<Sidebar />, { api })
    await user.click(screen.getByRole('button', { name: 'Localizar arquivo: sumiu.mp4' }))
    expect(api.queue.retry).toHaveBeenCalledWith(moved.id, '/novo/sumiu.mp4')
    api.files.choose.mockResolvedValue([])
    await user.click(screen.getByRole('button', { name: 'Localizar arquivo: sumiu.mp4' }))
    expect(api.queue.retry).toHaveBeenCalledTimes(1)
  })

  it('corrompidos aparecem com "Excluir"', async () => {
    const api = new FakeApi()
    api.corrupted = ['quebrado-id']
    const { user } = await renderWithApp(<Sidebar />, { api })
    expect(screen.getByText('Não foi possível abrir')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Excluir: quebrado-id' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Excluir' })
    )
    expect(api.history.remove).toHaveBeenCalledWith('quebrado-id')
  })

  it('erros das ações viram avisos', async () => {
    const failed = makeMeta({ fileName: 'ruim.mp4', status: 'interrupted' })
    const api = withEntries(failed)
    api.queue.retry.mockRejectedValue(apiError('INVALID_REQUEST', 'não dá'))
    const { user, store } = await renderWithApp(<Sidebar />, { api })
    await user.click(screen.getByRole('button', { name: 'Transcrever de novo: ruim.mp4' }))
    expect(store.getState().notices).toMatchObject([
      { kind: 'error', error: { message: 'não dá' } }
    ])
  })

  it('eventos da fila atualizam a lista ao vivo', async () => {
    const { api } = await renderWithApp(<Sidebar />)
    act(() => {
      api.emitQueue({ type: 'job', meta: makeMeta({ fileName: 'novo.mp3', status: 'queued' }) })
    })
    expect(screen.getByRole('region', { name: 'Fila (1)' })).toHaveTextContent('novo.mp3')
  })
})
