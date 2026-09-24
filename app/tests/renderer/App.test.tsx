import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/renderer/src/App'
import { FakeApi } from './fake-api'
import { renderWithApp } from './render'

describe('App', () => {
  it('mostra "Carregando" até o estado do main chegar', async () => {
    await renderWithApp(<App />, { init: false })
    // Mesma tela do index.html (as barras do logo animadas): a troca não pisca.
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Carregando…')
    expect(status).toHaveClass('boot')
    expect(status.querySelectorAll('.boot-bar')).toHaveLength(5)
    expect(await screen.findByText('Solte vídeos ou áudios aqui')).toBeInTheDocument()
  })

  it('sem modelo configurado abre o onboarding', async () => {
    await renderWithApp(<App />, { api: new FakeApi({ model: null }), init: false })
    expect(
      await screen.findByRole('heading', { name: 'Bem-vindo ao Whisper Transcriber' })
    ).toBeInTheDocument()
  })

  it('⚙ abre as configurações e "Voltar" retorna', async () => {
    const { user } = await renderWithApp(<App />, { init: false })
    await user.click(await screen.findByRole('button', { name: 'Configurações' }))
    expect(screen.getByRole('heading', { name: 'Geral' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Voltar' }))
    expect(screen.getByText('Solte vídeos ou áudios aqui')).toBeInTheDocument()
  })
})
