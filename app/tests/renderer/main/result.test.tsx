import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlayerProvider } from '../../../src/renderer/src/hooks/usePlayer'
import { JsonView, tokenize } from '../../../src/renderer/src/screens/main/JsonView'
import { Player } from '../../../src/renderer/src/screens/main/Player'
import { ResultPanel } from '../../../src/renderer/src/screens/main/ResultPanel'
import { toJson, toTimestamped } from '../../../src/shared/format'
import type { HistoryDetail } from '../../../src/shared/ipc'
import { apiError, FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const transcript = [
  { inicio: 0, fim: 2, texto: 'Bom dia.' },
  { inicio: 2.2, fim: 4, texto: 'Hoje falamos de áudio.' },
  { inicio: 6, fim: 8, texto: 'Novo assunto.' }
]

function setup(api = new FakeApi()) {
  const meta = makeMeta({ fileName: 'aula 03.mp4' })
  const detail: HistoryDetail = { meta, transcript, videoAvailable: true, hasRedo: false }
  return renderWithApp(
    <PlayerProvider>
      <Player meta={meta} detail={detail} />
      <ResultPanel meta={meta} detail={detail} />
    </PlayerProvider>,
    { api }
  )
}

describe('ResultPanel', () => {
  it('aba Trechos: a primeira, aberta ao terminar, com balões clicáveis como na transcrição', async () => {
    const { user, container } = await setup()
    expect(screen.getByRole('tab', { name: 'Trechos' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Trechos',
      'Texto',
      'Com tempos',
      'JSON'
    ])
    const bubble = screen.getByRole('button', { name: /00:06 Novo assunto\./ })
    await user.click(bubble)
    expect(container.querySelector('video')!.currentTime).toBe(6)
    expect(bubble).toHaveAttribute('aria-current', 'true')
    await expectAccessible(container)
  })

  it('cabeçalho mostra "via <IA>"; desconhecido mostra o nome cru; sem requestedBy, nada', async () => {
    const mapped = makeMeta({ fileName: 'aula 03.mp4', requestedBy: 'claude-code' })
    const detail: HistoryDetail = { meta: mapped, transcript, videoAvailable: true, hasRedo: false }
    const { container, rerender } = await renderWithApp(
      <PlayerProvider>
        <ResultPanel meta={mapped} detail={detail} />
      </PlayerProvider>
    )
    expect(screen.getByText('via Claude Code')).toBeInTheDocument()
    await expectAccessible(container)

    const unknown = makeMeta({ fileName: 'outra.mp4', requestedBy: 'minha-ia' })
    rerender(
      <PlayerProvider>
        <ResultPanel
          meta={unknown}
          detail={{ meta: unknown, transcript, videoAvailable: true, hasRedo: false }}
        />
      </PlayerProvider>
    )
    expect(screen.getByText('via minha-ia')).toBeInTheDocument()
    expect(screen.queryByText('via Claude Code')).not.toBeInTheDocument()
  })

  it('sem requestedBy não mostra selo no resultado', async () => {
    await setup()
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument()
  })

  it('aba Texto: parágrafos clicáveis que pulam o player e destacam o que toca', async () => {
    const { user, container } = await setup()
    await user.click(screen.getByRole('tab', { name: 'Texto' }))
    const first = screen.getByRole('button', { name: /Bom dia\. Hoje falamos de áudio\./ })
    const second = screen.getByRole('button', { name: /Novo assunto\./ })
    await user.click(second)
    const video = container.querySelector('video')!
    expect(video.currentTime).toBe(6)
    expect(second).toHaveAttribute('aria-current', 'true')
    video.currentTime = 1
    fireEvent.timeUpdate(video)
    await waitFor(() => {
      expect(first).toHaveAttribute('aria-current', 'true')
    })
    await expectAccessible(container)
  })

  it('aba Com tempos e aba JSON mostram os formatos do CLI', async () => {
    const { user } = await setup()
    await user.click(screen.getByRole('tab', { name: 'Com tempos' }))
    expect(screen.getByRole('tabpanel')).toHaveTextContent('[00:00 - 00:02] Bom dia.')
    await user.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(screen.getByRole('tabpanel').textContent).toBe(toJson(transcript))
  })

  it('Copiar copia o conteúdo da aba aberta (Trechos: com os tempos)', async () => {
    const { user, api } = await setup()
    await user.click(screen.getByRole('button', { name: 'Copiar' }))
    expect(api.clipboard.write).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\[00:00 - 00:02\] Bom dia\.\n/)
    )
    expect(await screen.findByRole('button', { name: '✓ Copiado' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Texto' }))
    await user.click(screen.getByRole('button', { name: /Copiar|Copiado/ }))
    expect(api.clipboard.write).toHaveBeenLastCalledWith(
      'Bom dia. Hoje falamos de áudio.\n\nNovo assunto.'
    )
  })

  it('Baixar sugere transcricao-<nome>.txt ou .json e avisa quando salvou', async () => {
    const api = new FakeApi()
    const { user, store } = await setup(api)
    await user.click(screen.getByRole('button', { name: 'Baixar' }))
    expect(api.files.save).toHaveBeenLastCalledWith({
      defaultName: 'transcricao-aula 03.txt',
      content: toTimestamped(transcript)
    })
    expect(store.getState().notices).toMatchObject([{ kind: 'info', key: 'result.saved' }])
    await user.click(screen.getByRole('tab', { name: 'JSON' }))
    api.files.save.mockResolvedValueOnce(false) // usuário cancelou o diálogo
    await user.click(screen.getByRole('button', { name: 'Baixar' }))
    expect(api.files.save).toHaveBeenLastCalledWith({
      defaultName: 'transcricao-aula 03.json',
      content: toJson(transcript)
    })
    expect(store.getState().notices).toHaveLength(1)
    api.files.save.mockRejectedValueOnce(apiError('DISK_FULL'))
    await user.click(screen.getByRole('button', { name: 'Baixar' }))
    expect(store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      key: 'errors.DISK_FULL'
    })
  })

  it('sem falas reconhecidas avisa e desliga Copiar e Baixar', async () => {
    const meta = makeMeta()
    await renderWithApp(
      <PlayerProvider>
        <ResultPanel
          meta={meta}
          detail={{ meta, transcript: [], videoAvailable: true, hasRedo: false }}
        />
      </PlayerProvider>
    )
    expect(screen.getByText('Nenhuma fala foi reconhecida neste arquivo.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copiar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Baixar' })).toBeDisabled()
  })

  it('concluído sem fala: dica e "Transcrever de novo" no aviso e na barra', async () => {
    const api = new FakeApi()
    const meta = makeMeta({ status: 'done' })
    const { user } = await renderWithApp(
      <PlayerProvider>
        <ResultPanel
          meta={meta}
          detail={{ meta, transcript: [], videoAvailable: true, hasRedo: false }}
        />
      </PlayerProvider>,
      { api }
    )
    expect(screen.getByText(/modelo maior/)).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Transcrever de novo' })
    expect(buttons).toHaveLength(2)
    await user.click(buttons[1]!)
    expect(api.queue.retry).toHaveBeenCalledWith(meta.id)
  })

  it('concluído com texto: "Transcrever de novo" só na barra; em processamento, nenhum', async () => {
    const api = new FakeApi()
    const meta = makeMeta({ status: 'done' })
    const detail: HistoryDetail = { meta, transcript, videoAvailable: true, hasRedo: false }
    const { user, unmount } = await renderWithApp(
      <PlayerProvider>
        <ResultPanel meta={meta} detail={detail} />
      </PlayerProvider>,
      { api }
    )
    await user.click(screen.getByRole('button', { name: 'Transcrever de novo' }))
    expect(api.queue.retry).toHaveBeenCalledWith(meta.id)
    unmount()
    const processing = { ...meta, status: 'processing' as const }
    await renderWithApp(
      <PlayerProvider>
        <ResultPanel meta={processing} detail={{ ...detail, meta: processing }} />
      </PlayerProvider>
    )
    expect(screen.queryByRole('button', { name: 'Transcrever de novo' })).not.toBeInTheDocument()
  })

  it('enquanto o detalhe carrega, mostra o painel vazio sem quebrar', async () => {
    const meta = makeMeta()
    await renderWithApp(
      <PlayerProvider>
        <ResultPanel meta={meta} detail={null} />
      </PlayerProvider>
    )
    expect(screen.getByRole('tablist')).toBeInTheDocument()
  })
})

describe('JsonView', () => {
  it('realça chaves, textos, números e pontuação sem perder nenhum caractere', async () => {
    const json = toJson([
      { inicio: 0, fim: 1.5, texto: 'aspas \\" e \\\\ barra' },
      { inicio: -1, fim: 2e-7, texto: '' }
    ])
    const { container } = await renderWithApp(<JsonView json={json} />)
    expect(container.textContent).toBe(json)
    expect(container.querySelectorAll('[data-token="key"]')).toHaveLength(6)
    expect(container.querySelectorAll('[data-token="string"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-token="number"]')).toHaveLength(4)
  })

  it('tokens colados e texto terminando em token', () => {
    expect(tokenize('1"a"')).toEqual([
      { text: '1', kind: 'number' },
      { text: '"a"', kind: 'string' }
    ])
  })
})
