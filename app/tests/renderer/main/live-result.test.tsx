import { act, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlayerProvider } from '../../../src/renderer/src/hooks/usePlayer'
import { MainScreen } from '../../../src/renderer/src/screens/main/MainScreen'
import { Player } from '../../../src/renderer/src/screens/main/Player'
import { ResultPanel } from '../../../src/renderer/src/screens/main/ResultPanel'
import type { HistoryMeta } from '../../../src/shared/history'
import type { HistoryDetail } from '../../../src/shared/ipc'
import { FakeApi, makeMeta } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const conversation = [
  { inicio: 0, fim: 2, texto: 'Bom dia.', falante: 'outros' as const },
  { inicio: 2.5, fim: 4, texto: 'Bom dia, tudo bem?', falante: 'voce' as const }
]

function liveMeta(patch: Partial<HistoryMeta> = {}): HistoryMeta {
  return makeMeta({
    kind: 'live',
    fileName: 'Reunião 23/09 10:00',
    sourcePath: '',
    mediaKind: 'audio',
    tracks: ['voce', 'outros'],
    activeVersion: 'live',
    ...patch
  })
}

function render(meta: HistoryMeta, detail: Partial<HistoryDetail> = {}, api = new FakeApi()) {
  const full: HistoryDetail = {
    meta,
    transcript: conversation,
    videoAvailable: false,
    hasRedo: false,
    ...detail
  }
  return renderWithApp(
    <PlayerProvider>
      <Player meta={meta} detail={full} />
      <ResultPanel meta={meta} detail={full} />
    </PlayerProvider>,
    { api }
  )
}

const audioSrc = (container: HTMLElement) => container.querySelector('audio')?.getAttribute('src')

describe('resultado do ao vivo', () => {
  it('player escolhe Tudo · Você · Outros', async () => {
    const meta = liveMeta()
    const { user, container } = await render(meta)
    const group = screen.getByRole('radiogroup', { name: 'Ouvir' })
    expect(within(group).getByRole('radio', { name: 'Tudo' })).toBeChecked()
    expect(audioSrc(container)).toBe(`app-media://${meta.id}/audio?v=done`)
    await user.click(within(group).getByRole('radio', { name: 'Você' }))
    expect(audioSrc(container)).toBe(`app-media://${meta.id}/voce?v=done`)
    await user.click(within(group).getByRole('radio', { name: 'Outros' }))
    expect(audioSrc(container)).toBe(`app-media://${meta.id}/outros?v=done`)
    await expectAccessible(container)
  })

  it('só o microfone gravado: sem seletor de faixa', async () => {
    await render(liveMeta({ tracks: ['voce'] }))
    expect(screen.queryByRole('radiogroup', { name: 'Ouvir' })).not.toBeInTheDocument()
  })

  it('aviso "Transcrita ao vivo" oferece refazer com o áudio completo', async () => {
    const meta = liveMeta()
    const { api, user } = await render(meta)
    const banner = screen.getByRole('note')
    expect(banner).toHaveTextContent('Transcrita ao vivo')
    await user.click(within(banner).getByRole('button', { name: 'Refazer com o áudio completo' }))
    expect(api.queue.retry).toHaveBeenCalledWith(meta.id)
    expect(screen.queryByRole('radiogroup', { name: 'Versão' })).not.toBeInTheDocument()
  })

  it('depois de refazer: escolhe a versão (Refeita · Ao vivo), sem o aviso', async () => {
    const meta = liveMeta({ activeVersion: 'redo' })
    const { api, user } = await render(meta, { hasRedo: true })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    const versions = screen.getByRole('radiogroup', { name: 'Versão' })
    expect(within(versions).getByRole('radio', { name: 'Refeita' })).toBeChecked()
    await user.click(within(versions).getByRole('radio', { name: 'Ao vivo' }))
    expect(api.history.setVersion).toHaveBeenCalledWith(meta.id, 'live')
  })

  it('refeito mas vendo a versão ao vivo: ainda dá para refazer de novo pelo botão da barra', async () => {
    const meta = liveMeta({ activeVersion: 'live' })
    await render(meta, { hasRedo: true })
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('radiogroup', { name: 'Versão' })).getByRole('radio', {
        name: 'Ao vivo'
      })
    ).toBeChecked()
  })

  it('o falante aparece nos trechos e nos formatos', async () => {
    const { user } = await render(liveMeta())
    expect(screen.getByRole('button', { name: /Outros.*00:00.*Bom dia\./ })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Com tempos' }))
    expect(screen.getByText(/\[00:02 - 00:04\] Você: Bom dia, tudo bem\?/)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Texto' }))
    expect(screen.getByRole('button', { name: 'Outros: Bom dia.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Você: Bom dia, tudo bem?' })).toBeInTheDocument()
  })

  it('trocar a versão recarrega a transcrição mostrada', async () => {
    const api = new FakeApi()
    const meta = liveMeta({ activeVersion: 'redo' })
    api.entries = [meta]
    api.details.set(meta.id, {
      meta,
      transcript: conversation,
      videoAvailable: false,
      hasRedo: true
    })
    const { store, user } = await renderWithApp(<MainScreen />, { api })
    act(() => {
      store.getState().select(meta.id)
    })
    await screen.findByRole('radiogroup', { name: 'Versão' })
    const calls = api.history.get.mock.calls.length
    await user.click(screen.getByRole('radio', { name: 'Ao vivo' }))
    await waitFor(() => {
      expect(api.history.get.mock.calls.length).toBeGreaterThan(calls)
    })
  })
})
