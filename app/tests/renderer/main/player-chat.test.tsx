import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/src/screens/main/ChatPanel'
import { Player } from '../../../src/renderer/src/screens/main/Player'
import { PlayerProvider, usePlayer } from '../../../src/renderer/src/hooks/usePlayer'
import type { HistoryMeta } from '../../../src/shared/history'
import type { HistoryDetail } from '../../../src/shared/ipc'
import { FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

function detailOf(meta: HistoryMeta, patch: Partial<HistoryDetail> = {}): HistoryDetail {
  return { meta, transcript: [], videoAvailable: true, hasRedo: false, ...patch }
}

function mediaOf(container: HTMLElement): HTMLMediaElement {
  const media = container.querySelector('video, audio')
  if (!(media instanceof HTMLMediaElement)) throw new Error('sem player')
  return media
}

describe('Player', () => {
  it('vídeo com o original disponível, cabeçalho com duração, modelo e idioma', async () => {
    const meta = makeMeta({ fileName: 'aula.mp4', duration: 3725, languageDetected: 'pt' })
    const { container } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={detailOf(meta)} />
      </PlayerProvider>
    )
    expect(screen.getByRole('heading', { name: 'aula.mp4' })).toBeInTheDocument()
    expect(screen.getByText('01:02:05 · Medium · português')).toBeInTheDocument()
    const video = mediaOf(container)
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe(`app-media://${meta.id}/video?v=done`)
    await expectAccessible(container)
  })

  it('original sumido ou que o Chromium não toca: cai para o áudio salvo com aviso', async () => {
    const meta = makeMeta({ duration: null, languageDetected: null, language: null })
    const { container, rerender } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={detailOf(meta, { videoAvailable: false })} />
      </PlayerProvider>
    )
    expect(mediaOf(container).getAttribute('src')).toBe(`app-media://${meta.id}/audio?v=done`)
    expect(screen.getByText(/tocando o áudio salvo/)).toBeInTheDocument()
    expect(screen.getByText('Medium · idioma automático')).toBeInTheDocument()
    const other = makeMeta()
    rerender(
      <PlayerProvider>
        <Player key={other.id} meta={other} detail={detailOf(other)} />
      </PlayerProvider>
    )
    fireEvent.error(mediaOf(container))
    expect(mediaOf(container).getAttribute('src')).toBe(`app-media://${other.id}/audio?v=done`)
    expect(screen.getByText(/tocando o áudio salvo/)).toBeInTheDocument()
  })

  it('transcrevendo com o vídeo pausado: a posição acompanha a transcrição; play devolve o controle', async () => {
    const job = makeMeta({ status: 'processing', duration: null })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    const { container } = await renderWithApp(
      <PlayerProvider>
        <Player meta={job} detail={detailOf(job)} />
      </PlayerProvider>,
      { api }
    )
    const video = mediaOf(container)
    const progress = (processedS: number) => {
      act(() => {
        api.emitQueue({
          type: 'progress',
          jobId: job.id,
          pct: 10,
          processedS,
          totalS: 858,
          speed: 3
        })
      })
    }
    act(() => {
      api.emitQueue({ type: 'phase', jobId: job.id, phase: 'extracting_audio' })
    })
    progress(500) // extraindo o áudio: o tempo é da extração, não da fala — não mexe no vídeo
    expect(video.currentTime).toBe(0)
    act(() => {
      api.emitQueue({ type: 'phase', jobId: job.id, phase: 'transcribing' })
    })
    progress(260) // pausado (padrão): pula para 04:20, sem tocar
    expect(video.currentTime).toBe(260)
    progress(260.5) // menos de 1 s de diferença: não fica pulando à toa
    expect(video.currentTime).toBe(260)
    act(() => {
      video.dispatchEvent(new Event('play')) // o usuário deu play: o controle é dele
    })
    video.currentTime = 30
    progress(300)
    expect(video.currentTime).toBe(30)
  })

  it('concluído não mexe na posição do vídeo', async () => {
    const meta = makeMeta({ status: 'done' })
    const api = new FakeApi()
    const { container } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={detailOf(meta)} />
      </PlayerProvider>,
      { api }
    )
    act(() => {
      api.emitQueue({
        type: 'progress',
        jobId: meta.id,
        pct: 50,
        processedS: 100,
        totalS: 200,
        speed: 1
      })
    })
    expect(mediaOf(container).currentTime).toBe(0)
  })

  it('idioma desconhecido aparece pelo código', async () => {
    const meta = makeMeta({ languageDetected: 'xx' })
    await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={null} />
      </PlayerProvider>
    )
    expect(screen.getByText('02:05 · Medium · xx')).toBeInTheDocument()
  })

  it('áudio indisponível (ainda extraindo) avisa', async () => {
    const meta = makeMeta({ mediaKind: 'audio', fileName: 'nota.mp3' })
    const { container } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={null} />
      </PlayerProvider>
    )
    fireEvent.error(mediaOf(container))
    expect(screen.getByText('A mídia ainda não está disponível.')).toBeInTheDocument()
  })
})

describe('ChatPanel', () => {
  const segments = [
    { start: 0, end: 2, text: 'Primeiro trecho' },
    { start: 2, end: 5, text: 'Segundo trecho' }
  ]

  it('ao vivo: balões com tempo, "digitando" e rolagem para o fim', async () => {
    const job = makeMeta({ status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    const { container } = await renderWithApp(
      <PlayerProvider>
        <ChatPanel meta={job} detail={null} />
      </PlayerProvider>,
      { api }
    )
    expect(
      screen.getByText('Os trechos aparecem aqui enquanto a transcrição anda.')
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Transcrevendo…')
    const log = screen.getByRole('log', { name: 'Trechos' })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 900 })
    act(() => {
      for (const segment of segments) api.emitQueue({ type: 'segment', jobId: job.id, segment })
    })
    expect(screen.getByRole('button', { name: /00:02 Segundo trecho/ })).toBeInTheDocument()
    expect(log.scrollTop).toBe(900)
    await expectAccessible(container)
  })

  it('usuário rolou para cima: novos trechos não puxam a rolagem', async () => {
    const job = makeMeta({ status: 'processing' })
    const api = new FakeApi()
    api.entries = [job]
    api.current = job.id
    await renderWithApp(
      <PlayerProvider>
        <ChatPanel meta={job} detail={null} />
      </PlayerProvider>,
      { api }
    )
    const log = screen.getByRole('log')
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 300 })
    log.scrollTop = 100
    fireEvent.scroll(log)
    act(() => {
      api.emitQueue({ type: 'segment', jobId: job.id, segment: segments[0]! })
    })
    expect(log.scrollTop).toBe(100)
  })

  it('clicar no balão pula o player; o trecho que toca fica destacado', async () => {
    const meta = makeMeta({ status: 'interrupted' })
    const transcript = segments.map((s) => ({ inicio: s.start, fim: s.end, texto: s.text }))
    const { container, user } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={detailOf(meta, { transcript })} />
        <ChatPanel meta={meta} detail={detailOf(meta, { transcript })} />
      </PlayerProvider>
    )
    const video = mediaOf(container)
    await user.click(screen.getByRole('button', { name: /Segundo trecho/ }))
    expect(video.currentTime).toBe(2)
    expect(screen.getByRole('button', { name: /Segundo trecho/ })).toHaveAttribute(
      'aria-current',
      'true'
    )
    video.currentTime = 0.5
    fireEvent.timeUpdate(video)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Primeiro trecho/ })).toHaveAttribute(
        'aria-current',
        'true'
      )
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('falhou: mostra o erro com "Transcrever de novo" e, se o arquivo sumiu, "Localizar arquivo"', async () => {
    const meta = makeMeta({ status: 'failed', error: { code: 'FILE_NOT_FOUND', message: 'x' } })
    const api = new FakeApi()
    api.files.choose.mockResolvedValue(['/novo.mp4'])
    const { user } = await renderWithApp(
      <PlayerProvider>
        <ChatPanel meta={meta} detail={detailOf(meta)} />
      </PlayerProvider>,
      { api }
    )
    expect(screen.getByRole('alert')).toHaveTextContent('não está mais no lugar original')
    await user.click(screen.getByRole('button', { name: 'Localizar arquivo' }))
    expect(api.queue.retry).toHaveBeenCalledWith(meta.id, '/novo.mp4')
    await user.click(screen.getByRole('button', { name: 'Transcrever de novo' }))
    expect(api.queue.retry).toHaveBeenLastCalledWith(meta.id)
  })

  it('outro erro não oferece localizar', async () => {
    const meta = makeMeta({ status: 'failed', error: { code: 'NO_AUDIO', message: 'x' } })
    await renderWithApp(
      <PlayerProvider>
        <ChatPanel meta={meta} detail={null} />
      </PlayerProvider>
    )
    expect(screen.queryByRole('button', { name: 'Localizar arquivo' })).not.toBeInTheDocument()
  })

  it('clicar num trecho sem player montado só marca o trecho', async () => {
    const meta = makeMeta({ status: 'interrupted' })
    const transcript = [{ inicio: 3, fim: 4, texto: 'sozinho' }]
    const { user } = await renderWithApp(
      <PlayerProvider>
        <ChatPanel meta={meta} detail={detailOf(meta, { transcript })} />
      </PlayerProvider>
    )
    await user.click(screen.getByRole('button', { name: /sozinho/ }))
    expect(screen.getByRole('button', { name: /sozinho/ })).toHaveAttribute('aria-current', 'true')
  })

  it('attach(null) desliga o elemento: o seek só atualiza o tempo', async () => {
    function Detach() {
      const player = usePlayer()
      return (
        <button type="button" onClick={() => player.attach(null)}>
          desligar
        </button>
      )
    }
    const meta = makeMeta({ status: 'interrupted' })
    const transcript = [{ inicio: 7, fim: 9, texto: 'depois' }]
    const { user, container } = await renderWithApp(
      <PlayerProvider>
        <Player meta={meta} detail={detailOf(meta, { transcript })} />
        <ChatPanel meta={meta} detail={detailOf(meta, { transcript })} />
        <Detach />
      </PlayerProvider>
    )
    await user.click(screen.getByRole('button', { name: 'desligar' }))
    await user.click(screen.getByRole('button', { name: /depois/ }))
    expect(mediaOf(container).currentTime).toBe(0)
    expect(screen.getByRole('button', { name: /depois/ })).toHaveAttribute('aria-current', 'true')
  })

  it('usePlayer fora do PlayerProvider avisa', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const meta = makeMeta()
    await expect(renderWithApp(<ChatPanel meta={meta} detail={null} />)).rejects.toThrow(
      'usePlayer usado fora do PlayerProvider'
    )
  })
})
