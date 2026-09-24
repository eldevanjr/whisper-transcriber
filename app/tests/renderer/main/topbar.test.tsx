import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TopBar } from '../../../src/renderer/src/screens/main/TopBar'
import { FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

describe('TopBar', () => {
  it('sem job: só o nome e o botão de configurações', async () => {
    const { user, store, container } = await renderWithApp(<TopBar />)
    expect(screen.getByText('Whisper Transcriber')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Configurações' }))
    expect(store.getState().view).toBe('settings')
    await expectAccessible(container)
  })

  it('com job: fase, barra, tempos, restante e velocidade', async () => {
    const job = makeMeta({ fileName: 'aula.mp4', status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    await renderWithApp(<TopBar />, { api })
    expect(screen.getByText('Preparando')).toBeInTheDocument()
    act(() => {
      api.emitQueue({ type: 'phase', jobId: job.id, phase: 'transcribing' })
      api.emitQueue({
        type: 'progress',
        jobId: job.id,
        pct: 25,
        processedS: 60,
        totalS: 240,
        speed: 4
      })
    })
    expect(screen.getByText('aula.mp4')).toBeInTheDocument()
    expect(screen.getByText('Transcrevendo')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Progresso da transcrição' })).toHaveAttribute(
      'aria-valuenow',
      '25'
    )
    expect(screen.getByText('01:00 de 04:00')).toBeInTheDocument()
    expect(screen.getByText('faltam 00:45')).toBeInTheDocument()
    expect(screen.getByText('4,0×')).toBeInTheDocument()
  })

  it('refazer do ao vivo: mostra a faixa e o restante soma as faixas que faltam', async () => {
    const job = makeMeta({ fileName: 'Reunião', status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    await renderWithApp(<TopBar />, { api })
    const progress = { type: 'progress' as const, jobId: job.id, totalS: 240, speed: 4 }
    act(() => {
      api.emitQueue({
        ...progress,
        pct: 12.5,
        processedS: 60,
        pass: { track: 'voce', index: 0, count: 2 }
      })
    })
    expect(screen.getByText('Você (1 de 2)')).toBeInTheDocument()
    expect(screen.getByText('01:00 de 04:00')).toBeInTheDocument()
    expect(screen.getByText('faltam 01:45')).toBeInTheDocument() // 45 s desta + 60 s da próxima
    act(() => {
      api.emitQueue({
        ...progress,
        pct: 62.5,
        processedS: 60,
        pass: { track: 'outros', index: 1, count: 2 }
      })
    })
    expect(screen.getByText('Outros (2 de 2)')).toBeInTheDocument()
    expect(screen.getByText('faltam 00:45')).toBeInTheDocument()
  })

  it('extraindo o áudio do vídeo: a barra mostra o progresso da extração', async () => {
    const job = makeMeta({ fileName: 'reuniao.mp4', status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    await renderWithApp(<TopBar />, { api })
    act(() => {
      api.emitQueue({ type: 'phase', jobId: job.id, phase: 'extracting_audio' })
      api.emitQueue({
        type: 'progress',
        jobId: job.id,
        pct: 40,
        processedS: 340,
        totalS: 858,
        speed: 30
      })
    })
    expect(screen.getByText('Extraindo o áudio')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'Progresso da extração do áudio' })
    ).toHaveAttribute('aria-valuenow', '40')
  })

  it('cancelar pede confirmação', async () => {
    const job = makeMeta({ status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    const { user } = await renderWithApp(<TopBar />, { api })
    await user.click(screen.getByRole('button', { name: 'Cancelar transcrição' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Cancelar a transcrição?' })
    await user.click(within(dialog).getByRole('button', { name: 'Continuar transcrevendo' }))
    expect(api.queue.cancel).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancelar transcrição' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar transcrição' })
    )
    expect(api.queue.cancel).toHaveBeenCalled()
  })

  it('velocidade zero não mostra tempo restante', async () => {
    const job = makeMeta({ status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    await renderWithApp(<TopBar />, { api })
    act(() => {
      api.emitQueue({
        type: 'progress',
        jobId: job.id,
        pct: 0,
        processedS: 0,
        totalS: 240,
        speed: 0
      })
    })
    expect(screen.queryByText(/faltam/)).not.toBeInTheDocument()
  })

  it('job atual que ainda não chegou ao histórico mostra só o progresso', async () => {
    const api = new FakeApi()
    api.current = '00000000-0000-4000-8000-00000000abcd'
    await renderWithApp(<TopBar />, { api })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })
})
