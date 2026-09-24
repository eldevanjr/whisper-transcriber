import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBootstrap } from '../../src/renderer/src/hooks/useBootstrap'
import { useAppStore } from '../../src/renderer/src/providers'
import { FakeApi } from './fake-api'
import { renderWithApp } from './render'

function Probe() {
  const ready = useBootstrap()
  const theme = useAppStore((s) => s.settings?.theme)
  return <p>{ready ? `pronto ${theme}` : 'carregando'}</p>
}

describe('useBootstrap', () => {
  it('inicializa o store uma vez, sincroniza o idioma e desliga os ouvintes ao desmontar', async () => {
    const api = new FakeApi({ uiLanguage: null })
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-AR')
    const { unmount, i18n } = await renderWithApp(<Probe />, { api, init: false })
    expect(await screen.findByText('pronto system')).toBeInTheDocument()
    expect(i18n.language).toBe('es')
    expect(document.documentElement.lang).toBe('es')
    act(() => {
      api.emitSettings({ uiLanguage: 'en' })
    })
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(api.settings.get).toHaveBeenCalledTimes(1)
    unmount()
    expect(api.listenerCount()).toBe(0)
  })

  it('desmontar antes de a carga terminar também desliga os ouvintes', async () => {
    const api = new FakeApi()
    const { unmount } = await renderWithApp(<Probe />, { api, init: false })
    unmount()
    await vi.waitFor(() => {
      expect(api.settings.get).toHaveBeenCalled()
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.listenerCount()).toBe(0)
  })
})
