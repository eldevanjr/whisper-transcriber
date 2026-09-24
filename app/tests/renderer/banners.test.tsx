import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Banners } from '../../src/renderer/src/components/Banners'
import { apiError, FakeApi } from './fake-api'
import { renderWithApp } from './render'

const UPDATE = {
  available: true,
  latest: '0.2.0',
  url: 'https://github.com/eldevanjr/whisper-transcriber/releases/tag/v0.2.0',
  mode: 'link' as const
}

describe('Banners', () => {
  it('avisa nova versão com link que abre no navegador e pode ser dispensado', async () => {
    const api = new FakeApi()
    api.updates.check.mockResolvedValue(UPDATE)
    const { user } = await renderWithApp(<Banners />, { api })
    expect(await screen.findByText('Nova versão 0.2.0 disponível.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Baixar' }))
    expect(api.system.openExternal).toHaveBeenCalledWith(UPDATE.url)
    await user.click(screen.getByRole('button', { name: 'Dispensar aviso' }))
    expect(screen.queryByText(/Nova versão/)).not.toBeInTheDocument()
  })

  it('atualização automática: baixando, depois "Reiniciar para atualizar"', async () => {
    const api = new FakeApi()
    api.updates.check.mockResolvedValue({ ...UPDATE, mode: 'auto' })
    const { user } = await renderWithApp(<Banners />, { api })
    expect(await screen.findByText('Baixando a versão 0.2.0…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Baixar' })).not.toBeInTheDocument()
    act(() => {
      api.emitUpdate({ type: 'ready', version: '0.2.0' })
    })
    expect(screen.getByText('A versão 0.2.0 está pronta.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reiniciar para atualizar' }))
    expect(api.updates.install).toHaveBeenCalled()
  })

  it('download automático que termina antes da checagem responder já mostra o reiniciar', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<Banners />, { api })
    act(() => {
      api.emitUpdate({ type: 'ready', version: '0.3.0' })
    })
    expect(await screen.findByText('A versão 0.3.0 está pronta.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dispensar aviso' }))
    expect(screen.queryByText(/está pronta/)).not.toBeInTheDocument()
  })

  it('não mostra nada sem novidade, com a verificação desligada ou se a checagem falhar', async () => {
    const api = new FakeApi({ checkUpdates: false })
    api.updates.check.mockResolvedValue(UPDATE)
    const { unmount } = await renderWithApp(<Banners />, { api })
    expect(api.updates.check).not.toHaveBeenCalled()
    unmount()
    const offline = new FakeApi()
    offline.updates.check.mockRejectedValue(apiError('DOWNLOAD_FAILED'))
    await renderWithApp(<Banners />, { api: offline })
    await Promise.resolve()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('verificação que chega depois de desmontar é ignorada', async () => {
    const api = new FakeApi()
    let resolve: (value: typeof UPDATE) => void = () => undefined
    api.updates.check.mockReturnValue(new Promise((r) => (resolve = r)))
    const { unmount } = await renderWithApp(<Banners />, { api })
    unmount()
    resolve(UPDATE)
    await Promise.resolve()
    expect(screen.queryByText(/Nova versão/)).not.toBeInTheDocument()
  })

  it('antes da carga do estado não faz nada', async () => {
    const api = new FakeApi()
    const { container } = await renderWithApp(<Banners />, { api, init: false })
    expect(container).toBeEmptyDOMElement()
    expect(api.updates.check).not.toHaveBeenCalled()
  })

  it('avisa quando as configurações foram restauradas', async () => {
    const api = new FakeApi()
    api.app.info.mockResolvedValue({ version: '0.1.0', platform: 'linux', settingsRecovered: true })
    const { user } = await renderWithApp(<Banners />, { api })
    expect(screen.getByText(/voltaram ao padrão/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dispensar aviso' }))
    expect(screen.queryByText(/voltaram ao padrão/)).not.toBeInTheDocument()
  })
})
