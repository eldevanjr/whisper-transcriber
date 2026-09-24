import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsScreen } from '../../../src/renderer/src/screens/settings/SettingsScreen'
import licenses from '../../../resources/third-party-licenses.json'
import { expectAccessible, renderWithApp } from '../render'

async function openLicenses() {
  const rendered = await renderWithApp(<SettingsScreen />)
  act(() => {
    rendered.store.getState().openSettings('licenses')
  })
  return rendered
}

describe('Licenças', () => {
  it('lista todos os componentes com versão e licença, e a busca filtra por nome ou licença', async () => {
    const { user, container } = await openLicenses()
    expect(screen.getByText(`${licenses.length} componentes`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /FFmpeg.*LGPL-2\.1-or-later/ })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Buscar biblioteca ou licença' }), 'lgpl')
    expect(screen.getAllByRole('button', { name: /LGPL/ }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^react / })).not.toBeInTheDocument()
    await expectAccessible(container)
  })

  it('clicar mostra o texto completo e o link do projeto; voltar retorna à lista', async () => {
    const { user, api } = await openLicenses()
    await user.click(screen.getByRole('button', { name: /Modelos Whisper/ }))
    expect(screen.getByRole('heading', { name: 'Modelos Whisper (OpenAI)' })).toBeInTheDocument()
    expect(screen.getByText(/Copyright \(c\) 2022 OpenAI/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Abrir página do projeto' }))
    expect(api.system.openExternal).toHaveBeenCalledWith('https://huggingface.co/Systran')
    await user.click(screen.getByRole('button', { name: 'Voltar à lista' }))
    expect(screen.getByRole('searchbox')).toBeInTheDocument()
  })

  it('componente só com link (sem texto) mostra o botão e nenhum bloco de texto', async () => {
    const { user, container } = await openLicenses()
    const linkOnly = licenses.find((entry) => entry.text === '' && entry.url !== '')!
    await user.click(screen.getByRole('button', { name: new RegExp(`^${linkOnly.name} `) }))
    expect(screen.getByRole('button', { name: 'Abrir página do projeto' })).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
  })
})
