import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AboutSection } from '../../../src/renderer/src/screens/settings/AboutSection'
import { SettingsScreen } from '../../../src/renderer/src/screens/settings/SettingsScreen'
import type { SettingsSection } from '../../../src/renderer/src/store/app-store'
import { apiError, FakeApi, makeMeta, SYSTEM_INFO } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

async function open(section?: SettingsSection, api = new FakeApi()) {
  const rendered = await renderWithApp(<SettingsScreen />, { api })
  if (section) {
    act(() => {
      rendered.store.getState().openSettings(section)
    })
  }
  return rendered
}

describe('SettingsScreen', () => {
  it('menu lateral troca de seção e "Voltar" fecha', async () => {
    const { user, store, container } = await open()
    const nav = screen.getByRole('navigation', { name: 'Seções das configurações' })
    expect(within(nav).getByRole('button', { name: 'Geral' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await user.click(within(nav).getByRole('button', { name: 'Sobre' }))
    expect(store.getState().settingsSection).toBe('about')
    await user.click(screen.getByRole('button', { name: 'Voltar' }))
    expect(store.getState().view).toBe('main')
    await expectAccessible(container)
  })

  it('antes de o estado carregar mostra só o menu, sem quebrar', async () => {
    await renderWithApp(<SettingsScreen />, { init: false })
    expect(screen.getByRole('navigation')).toBeInTheDocument()
    await renderWithApp(<AboutSection />, { init: false })
    expect(screen.getByText('Versão')).toBeInTheDocument()
  })
})

describe('Geral', () => {
  it('idioma, tema e verificação de versões salvam na hora', async () => {
    const { user, api } = await open('general')
    await user.selectOptions(screen.getByLabelText('Idioma da interface'), 'en')
    expect(api.settings.update).toHaveBeenLastCalledWith({ uiLanguage: 'en' })
    await user.selectOptions(screen.getByLabelText('Idioma da interface'), 'system')
    expect(api.settings.update).toHaveBeenLastCalledWith({ uiLanguage: null })
    await user.click(screen.getByRole('radio', { name: 'Escuro' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ theme: 'dark' })
    await user.click(screen.getByRole('switch', { name: 'Verificar novas versões' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ checkUpdates: false })
  })

  it('erro ao salvar vira aviso', async () => {
    const api = new FakeApi()
    api.settings.update.mockRejectedValueOnce(apiError('INVALID_REQUEST', 'recusado'))
    const { user, store } = await open('general', api)
    await user.click(screen.getByRole('radio', { name: 'Claro' }))
    expect(store.getState().notices).toMatchObject([
      { kind: 'error', error: { message: 'recusado' } }
    ])
  })
})

describe('Transcrição — modelos', () => {
  it('mostra em uso, usar, baixar e remover', async () => {
    const api = new FakeApi()
    api.installed = ['medium', 'small']
    const { user, container } = await open('transcription', api)
    const list = await screen.findByRole('list', { name: 'Modelo' })
    const medium = within(list).getByText('Medium').closest('li')!
    expect(medium).toHaveTextContent('✓ Em uso')
    const small = within(list).getByText('Small').closest('li')!
    await user.click(within(small).getByRole('button', { name: 'Usar' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ model: 'small' })
    await expectAccessible(container)
  })

  it('baixar mostra a barra com cancelar e atualiza a lista ao terminar', async () => {
    const api = new FakeApi()
    let finish: () => void = () => undefined
    api.models.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            api.installed.push('small')
            resolve(null)
          }
        })
    )
    const { user } = await open('transcription', api)
    const list = await screen.findByRole('list', { name: 'Modelo' })
    const small = within(list).getByText('Small').closest('li')!
    await user.click(within(small).getByRole('button', { name: 'Baixar' }))
    expect(api.models.install).toHaveBeenCalledWith('small', 'ct2')
    act(() => {
      api.emitDownload({
        type: 'progress',
        target: { kind: 'model', id: 'small' },
        received: 1,
        total: 4
      })
    })
    expect(within(small).getByRole('progressbar', { name: 'Download de Small' })).toHaveAttribute(
      'aria-valuenow',
      '25'
    )
    await user.click(within(small).getByRole('button', { name: 'Cancelar download' }))
    expect(api.downloads.cancel).toHaveBeenCalledWith({ kind: 'model', id: 'small', format: 'ct2' })
    await act(async () => {
      finish()
      api.emitDownload({ type: 'done', target: { kind: 'model', id: 'small' } })
    })
    expect(await within(small).findByRole('button', { name: 'Usar' })).toBeInTheDocument()
  })

  it('download cancelado não avisa; falha avisa', async () => {
    const api = new FakeApi()
    api.models.install.mockRejectedValueOnce(apiError('CANCELED'))
    api.models.install.mockRejectedValueOnce(apiError('INSUFFICIENT_SPACE'))
    const { user, store } = await open('transcription', api)
    const list = await screen.findByRole('list', { name: 'Modelo' })
    const small = within(list).getByText('Small').closest('li')!
    await user.click(within(small).getByRole('button', { name: 'Baixar' }))
    expect(store.getState().notices).toEqual([])
    await user.click(within(small).getByRole('button', { name: 'Baixar' }))
    expect(store.getState().notices).toMatchObject([{ key: 'errors.INSUFFICIENT_SPACE' }])
  })

  it('remover pede confirmação com o espaço liberado', async () => {
    const api = new FakeApi()
    api.installed = ['medium', 'large-v3']
    const { user } = await open('transcription', api)
    const list = await screen.findByRole('list', { name: 'Modelo' })
    const large = within(list).getByText('Large v3').closest('li')!
    await user.click(within(large).getByRole('button', { name: 'Remover' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Remover o modelo Large v3?' })
    expect(dialog).toHaveTextContent('Libera 3,1 GB')
    await user.click(within(dialog).getByRole('button', { name: 'Remover' }))
    expect(api.models.remove).toHaveBeenCalledWith('large-v3', 'ct2')
    await user.click(within(large).getByRole('button', { name: 'Remover' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' })
    )
    expect(api.models.remove).toHaveBeenCalledTimes(1)
  })
})

const WITH_GPU = { ...SYSTEM_INFO, gpu: { name: 'RTX 4060', memoryMb: 8188 } }

describe('Transcrição — idioma e processamento', () => {
  it('idioma do áudio: detectar automaticamente ou um idioma fixo', async () => {
    const { user, api } = await open('transcription')
    const select = screen.getByRole('combobox', { name: 'Idioma do áudio' })
    expect(select).toHaveValue('pt')
    expect(
      within(select).getByRole('option', { name: 'Detectar automaticamente' })
    ).toBeInTheDocument()
    await user.selectOptions(select, 'auto')
    expect(api.settings.update).toHaveBeenLastCalledWith({ audioLanguage: 'auto' })
  })

  it('GPU sem bibliotecas: aceitar termos, baixar e passar a usar a GPU', async () => {
    const api = new FakeApi()
    api.system.info.mockResolvedValue(WITH_GPU)
    const { user } = await open('transcription', api)
    expect(await screen.findByText('Bibliotecas da NVIDIA não instaladas.')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /GPU NVIDIA/ })).toBeDisabled()
    const install = screen.getByRole('button', { name: 'Baixar bibliotecas' })
    expect(install).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Ler os termos' }))
    expect(api.system.openExternal).toHaveBeenCalledWith(expect.stringContaining('nvidia'))
    await user.click(screen.getByRole('checkbox', { name: /aceito os termos/ }))
    api.cuda.install.mockImplementation(() => {
      api.cudaInstalled = true
      return Promise.resolve(null)
    })
    await user.click(install)
    expect(api.settings.update.mock.calls.map((c) => c[0])).toEqual([
      { nvidiaTermsAccepted: true },
      { device: 'cuda' }
    ])
    expect(await screen.findByText('Bibliotecas da NVIDIA instaladas.')).toBeInTheDocument()
  })

  it('GPU instalada: alterna CPU/GPU, reinstala, remove e mostra progresso', async () => {
    const api = new FakeApi({ nvidiaTermsAccepted: true, device: 'cuda' })
    api.cudaInstalled = true
    const { user } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /CPU/ }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ device: 'cpu' })
    await user.click(screen.getByRole('radio', { name: /GPU NVIDIA/ }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ device: 'cuda' })
    api.cuda.install.mockReturnValue(new Promise(() => undefined))
    await user.click(screen.getByRole('button', { name: 'Reinstalar CUDA' }))
    act(() => {
      api.emitDownload({ type: 'progress', target: { kind: 'cuda' }, received: 0, total: 0 })
    })
    expect(
      screen.getByRole('progressbar', { name: 'Download das bibliotecas da NVIDIA' })
    ).toHaveAttribute('aria-valuenow', '0') // tamanho ainda desconhecido
    await user.click(screen.getByRole('button', { name: 'Cancelar download' }))
    expect(api.downloads.cancel).toHaveBeenCalledWith({ kind: 'cuda' })
    await user.click(screen.getByRole('button', { name: 'Remover bibliotecas' }))
    expect(api.cuda.remove).toHaveBeenCalled()
  })

  it('falha ao instalar CUDA avisa', async () => {
    const api = new FakeApi({ nvidiaTermsAccepted: true })
    api.system.info.mockResolvedValue(WITH_GPU)
    api.cuda.install.mockRejectedValueOnce(apiError('HASH_MISMATCH'))
    const { user, store } = await open('transcription', api)
    await user.click(await screen.findByRole('button', { name: 'Baixar bibliotecas' }))
    await vi.waitFor(() => {
      expect(store.getState().notices).toMatchObject([{ key: 'errors.HASH_MISMATCH' }])
    })
  })

  it('sistema sem suporte a CUDA (macOS) explica em vez de esconder', async () => {
    const api = new FakeApi()
    api.system.info.mockResolvedValue({ ...SYSTEM_INFO, platform: 'darwin', arch: 'x64' })
    api.cuda.status.mockResolvedValue({ supported: false, installed: false, sizeBytes: 0 })
    await open('transcription', api)
    expect(await screen.findByText(/Este sistema não suporta a aceleração/)).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /GPU NVIDIA/ })).not.toBeInTheDocument()
  })

  it('sem placa NVIDIA: mensagem de indisponível, sem opção nem download de bibliotecas', async () => {
    const api = new FakeApi()
    api.system.info.mockResolvedValue({ ...SYSTEM_INFO, gpu: null })
    await open('transcription', api)
    expect(await screen.findByText('Aceleração por GPU não disponível')).toBeInTheDocument()
    expect(screen.getByText(/Não encontramos uma placa de vídeo compatível/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Baixar bibliotecas' })).not.toBeInTheDocument()
  })
})

describe('Armazenamento', () => {
  it('mostra o uso, abre a pasta e limpa o histórico com alerta', async () => {
    const api = new FakeApi()
    api.installed = ['medium', 'small']
    api.cudaInstalled = true
    api.entries = [makeMeta(), makeMeta()]
    const { user, container } = await open('storage', api)
    expect(await screen.findByText('2 GB')).toBeInTheDocument() // medium + small
    expect(screen.getByText('1,2 GB')).toBeInTheDocument()
    expect(screen.getByText('Histórico (2 transcrições)')).toBeInTheDocument()
    expect(screen.getByText('52 MB')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Abrir pasta' }))
    expect(api.system.openDataFolder).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Limpar histórico…' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Limpar o histórico?' })
    expect(dialog).toHaveTextContent('Apagar 2 transcrições e 52 MB. Não pode ser desfeito.')
    await expectAccessible(container)
    await user.click(within(dialog).getByRole('button', { name: 'Apagar tudo' }))
    expect(api.history.clear).toHaveBeenCalled()
    expect(api.history.list).toHaveBeenCalledTimes(2) // carga + depois de limpar
  })

  it('limpar com a fila andando avisa o motivo; cancelar o alerta não apaga', async () => {
    const api = new FakeApi()
    api.history.clear.mockRejectedValue(apiError('INVALID_REQUEST', 'Aguarde a fila terminar'))
    const { user, store } = await open('storage', api)
    await user.click(await screen.findByRole('button', { name: 'Limpar histórico…' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' })
    )
    expect(api.history.clear).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Limpar histórico…' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apagar tudo' })
    )
    expect(store.getState().notices).toMatchObject([
      { kind: 'error', error: { message: 'Aguarde a fila terminar' } }
    ])
  })
})

describe('Ajuda', () => {
  it('lista os artigos e a busca filtra ignorando acentos', async () => {
    const { user, container } = await open('help')
    expect(screen.getByRole('heading', { name: 'Guia rápido' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Aceleração por GPU' })).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Buscar na ajuda' }), 'memoria')
    expect(screen.queryByRole('heading', { name: 'Guia rápido' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Problemas comuns' })).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'zzzz')
    expect(screen.getByText('Nada encontrado.')).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('relatar problema abre uma issue', async () => {
    const { user, api } = await open('help')
    await user.click(screen.getByRole('button', { name: 'Relatar problema' }))
    expect(api.system.openExternal.mock.calls[0]![0]).toContain('/issues/new')
  })
})

describe('Sobre', () => {
  it('versão, autor com GitHub, licença, aviso da OpenAI e atalho para as licenças', async () => {
    const { user, api, store, container } = await open('about')
    expect(screen.getByText('Versão 0.1.0')).toBeInTheDocument()
    expect(screen.getByText('Eldevan Nery Junior')).toBeInTheDocument()
    expect(screen.getByText(/Apache 2\.0/)).toBeInTheDocument()
    expect(screen.getByText(/sem vínculo com a OpenAI/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'github.com/eldevanjr' }))
    expect(api.system.openExternal).toHaveBeenCalledWith('https://github.com/eldevanjr')
    await user.click(screen.getByRole('button', { name: 'Licenças de terceiros' }))
    expect(store.getState().settingsSection).toBe('licenses')
    await expectAccessible(container)
  })
})

describe('Transcrição — GPU pelo whisper.cpp (Vulkan/Metal)', () => {
  const INTEL = {
    ...SYSTEM_INFO,
    accelerator: { name: 'Intel Iris Xe Graphics', api: 'vulkan' as const }
  }

  it('oferece a GPU detectada; sem o modelo GGML, baixa antes de trocar', async () => {
    const api = new FakeApi()
    api.system.info.mockResolvedValue(INTEL)
    let finish: () => void = () => undefined
    api.models.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(null)
          }
        })
    )
    const { user } = await open('transcription', api)
    const option = await screen.findByRole('radio', { name: /GPU \(Intel Iris Xe Graphics\)/ })
    await user.click(option)
    expect(api.models.install).toHaveBeenCalledWith('medium', 'ggml')
    expect(api.settings.update).not.toHaveBeenCalledWith({ device: 'gpu' })
    act(() => {
      api.emitDownload({
        type: 'progress',
        target: { kind: 'model', id: 'medium', format: 'ggml' },
        received: 1,
        total: 2
      })
    })
    expect(
      screen.getByRole('progressbar', { name: 'Download do modelo para a GPU' })
    ).toBeInTheDocument()
    await act(async () => {
      finish()
    })
    await vi.waitFor(() => {
      expect(api.settings.update).toHaveBeenCalledWith({ device: 'gpu' })
    })
  })

  it('com o modelo GGML já baixado, troca na hora; a lista de modelos mostra o formato da GPU', async () => {
    const api = new FakeApi({ device: 'gpu' })
    api.system.info.mockResolvedValue(INTEL)
    const { user } = await open('transcription', api)
    await screen.findByRole('list', { name: 'Modelo' })
    expect(api.models.status).toHaveBeenCalledWith('ggml')
    const list = screen.getByRole('list', { name: 'Modelo' })
    await user.click(
      within(within(list).getByText('Small').closest('li')!).getByRole('button', { name: 'Baixar' })
    )
    expect(api.models.install).toHaveBeenLastCalledWith('small', 'ggml')
    await user.click(screen.getByRole('radio', { name: /CPU/ }))
    expect(api.settings.update).toHaveBeenLastCalledWith({ device: 'cpu' })
  })

  it('já na GPU: escolher a GPU de novo com o modelo GGML instalado só grava', async () => {
    const api = new FakeApi({ device: 'cpu' })
    api.system.info.mockResolvedValue(INTEL)
    api.models.status.mockImplementation((format?: string) =>
      Promise.resolve({
        installed: format === 'ggml' ? ['medium'] : ['medium'],
        partial: [],
        sizes: { small: 1, medium: 2, 'large-v3-turbo': 3, 'large-v3': 4 }
      })
    )
    const { user } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /GPU \(Intel/ }))
    expect(api.models.install).not.toHaveBeenCalled()
    expect(api.settings.update).toHaveBeenCalledWith({ device: 'gpu' })
  })

  it('falha ao baixar o modelo da GPU avisa e continua na CPU', async () => {
    const api = new FakeApi()
    api.system.info.mockResolvedValue(INTEL)
    api.models.install.mockRejectedValueOnce(apiError('DOWNLOAD_FAILED'))
    const { user, store } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /GPU \(Intel/ }))
    await vi.waitFor(() => {
      expect(store.getState().notices).toMatchObject([{ key: 'errors.DOWNLOAD_FAILED' }])
    })
    expect(api.settings.update).not.toHaveBeenCalledWith({ device: 'gpu' })
  })

  it('CUDA já em uso sem placa detectada continua oferecendo a NVIDIA; sem sistema, sem opções', async () => {
    const api = new FakeApi({ device: 'cuda' })
    const { store } = await open('transcription', api)
    expect(await screen.findByRole('radio', { name: /GPU NVIDIA/ })).toBeInTheDocument()
    act(() => {
      store.setState({ systemInfo: null })
      api.emitSettings({ device: 'cpu' })
    })
    expect(await screen.findByText('Aceleração por GPU não disponível')).toBeInTheDocument()
  })

  it('da GPU para a CPU sem o modelo da CPU: baixa antes de trocar, com a barra', async () => {
    // Quem fez o onboarding na GPU só tem o GGML; sem baixar, o próximo job falharia.
    const api = new FakeApi({ device: 'gpu' })
    api.system.info.mockResolvedValue(INTEL)
    api.installed = []
    api.installedGgml = ['medium']
    let finish: () => void = () => undefined
    api.models.install.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve(null)
          }
        })
    )
    const { user } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /CPU/ }))
    expect(api.models.install).toHaveBeenCalledWith('medium', 'ct2')
    expect(api.settings.update).not.toHaveBeenCalledWith({ device: 'cpu' })
    act(() => {
      api.emitDownload({
        type: 'progress',
        target: { kind: 'model', id: 'medium' },
        received: 1,
        total: 2
      })
    })
    expect(
      screen.getByRole('progressbar', { name: 'Download do modelo para a CPU' })
    ).toBeInTheDocument()
    await act(async () => {
      finish()
    })
    await vi.waitFor(() => {
      expect(api.settings.update).toHaveBeenCalledWith({ device: 'cpu' })
    })
  })

  it('falha ao baixar o modelo da CPU avisa e continua na GPU', async () => {
    const api = new FakeApi({ device: 'gpu' })
    api.system.info.mockResolvedValue(INTEL)
    api.installed = []
    api.installedGgml = ['medium']
    api.models.install.mockRejectedValueOnce(apiError('DOWNLOAD_FAILED'))
    const { user, store } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /CPU/ }))
    await vi.waitFor(() => {
      expect(store.getState().notices).toMatchObject([{ key: 'errors.DOWNLOAD_FAILED' }])
    })
    expect(api.settings.update).not.toHaveBeenCalledWith({ device: 'cpu' })
  })

  it('sem modelo configurado a GPU só grava o dispositivo', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(INTEL)
    const { user } = await open('transcription', api)
    await user.click(await screen.findByRole('radio', { name: /GPU \(Intel/ }))
    expect(api.models.install).not.toHaveBeenCalled()
    expect(api.settings.update).toHaveBeenCalledWith({ device: 'gpu' })
  })
})

describe('Ao vivo', () => {
  it('microfone padrão, áudio do computador e pausa', async () => {
    const { user, api, container } = await open('live')
    const select = screen.getByLabelText('Microfone')
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(2) // padrão + USB (sem monitor)
    })
    await user.selectOptions(select, 'mic1')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: 'mic1', systemAudio: true, pauseS: 1 }
    })
    await user.click(screen.getByRole('switch', { name: 'Áudio do computador (Outros)' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: 'mic1', systemAudio: false, pauseS: 1 }
    })
    fireEvent.change(screen.getByRole('slider', { name: 'Pausa que fecha uma frase' }), {
      target: { value: '2.5' }
    })
    expect(api.settings.update).toHaveBeenLastCalledWith({
      live: { micDeviceId: 'mic1', systemAudio: false, pauseS: 2.5 }
    })
    await expectAccessible(container)
  })
})
