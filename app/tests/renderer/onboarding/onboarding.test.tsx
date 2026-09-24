import { act, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../../../src/renderer/src/screens/onboarding/Onboarding'
import { apiError, FakeApi, SYSTEM_INFO } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const INTEL = {
  ...SYSTEM_INFO,
  cudaSupported: false,
  accelerator: { name: 'Intel Iris Xe Graphics', api: 'vulkan' as const },
  recommendedDevice: 'gpu' as const
}
const GPU = {
  ...SYSTEM_INFO,
  gpu: { name: 'RTX 4060', memoryMb: 8188 },
  recommendedModel: 'large-v3-turbo' as const
}

async function toModelStep(api = new FakeApi({ model: null })) {
  const rendered = await renderWithApp(<Onboarding />, { api })
  await rendered.user.click(screen.getByRole('button', { name: 'Continuar' }))
  await screen.findByRole('heading', { name: 'Escolha o modelo de transcrição' })
  return rendered
}

function deferred() {
  let resolve: (value: null) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Onboarding — boas-vindas', () => {
  it('mostra o passo, troca o idioma da interface e segue', async () => {
    const api = new FakeApi({ model: null })
    const { user, container } = await renderWithApp(<Onboarding />, { api })
    expect(
      screen.getByRole('heading', { name: 'Bem-vindo ao Whisper Transcriber' })
    ).toBeInTheDocument()
    expect(screen.getByText('Passo 1 de 3')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Idioma da interface'), 'es')
    expect(api.settings.update).toHaveBeenCalledWith({ uiLanguage: 'es' })
    await expectAccessible(container)
  })
})

describe('Onboarding — modelo', () => {
  it('4 modelos com tamanho, recomendado da máquina já marcado', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    const { container } = await toModelStep(api)
    const group = screen.getByRole('radiogroup', { name: 'Escolha o modelo de transcrição' })
    expect(within(group).getAllByRole('radio')).toHaveLength(4)
    const medium = screen.getByRole('radio', { name: /Medium/ })
    expect(medium).toBeChecked()
    expect(screen.getByText('Recomendado').closest('label')).toHaveTextContent('Medium')
    expect(screen.getByText('1,5 GB')).toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument() // sem GPU NVIDIA
    expect(screen.getByText('Aceleração por GPU não disponível')).toBeInTheDocument()
    expect(screen.getByText(/Não encontramos uma placa de vídeo compatível/)).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('sistema sem suporte a CUDA (macOS) explica que a GPU não é suportada', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue({ ...SYSTEM_INFO, platform: 'darwin', cudaSupported: false })
    await toModelStep(api)
    expect(screen.getByText(/Este sistema não suporta a aceleração por GPU/)).toBeInTheDocument()
  })

  it('pré-seleciona um modelo que já foi baixado', async () => {
    const api = new FakeApi({ model: null })
    api.installed = ['small']
    await toModelStep(api)
    expect(screen.getByRole('radio', { name: /Small/ })).toBeChecked()
  })

  it('reaberto depois de um download interrompido, pré-seleciona o modelo que estava baixando', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    api.partial = ['large-v3']
    await toModelStep(api)
    expect(screen.getByRole('radio', { name: /^Large v3(?! Turbo)/ })).toBeChecked()
  })

  it('com GPU NVIDIA: ativar exige aceitar os termos, que abrem no navegador', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    api.system.info.mockResolvedValue(GPU)
    const { user } = await toModelStep(api)
    expect(screen.getByRole('radio', { name: /Large v3 Turbo/ })).toBeChecked()
    const start = screen.getByRole('button', { name: 'Baixar e continuar' })
    await user.click(screen.getByRole('switch', { name: 'Usar a GPU NVIDIA (RTX 4060)' }))
    expect(start).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Ler os termos' }))
    expect(api.system.openExternal).toHaveBeenCalledWith(expect.stringContaining('docs.nvidia.com'))
    await user.click(screen.getByRole('checkbox', { name: /aceito os termos/ }))
    expect(start).toBeEnabled()
  })
})

describe('Onboarding — download e teste', () => {
  it('baixa com progresso, grava o modelo, roda o teste e libera "Começar"', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    const install = deferred()
    api.models.install.mockReturnValue(install.promise)
    const { user, store, container } = await toModelStep(api)
    await user.click(screen.getByRole('radio', { name: /Small/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    expect(await screen.findByRole('heading', { name: 'Preparando tudo' })).toBeInTheDocument()
    expect(api.models.install).toHaveBeenCalledWith('small', 'ct2')
    act(() => {
      api.emitDownload({
        type: 'progress',
        target: { kind: 'model', id: 'small' },
        received: 242_000_000,
        total: 484_000_000
      })
    })
    expect(screen.getByRole('progressbar', { name: 'Progresso do download' })).toHaveAttribute(
      'aria-valuenow',
      '50'
    )
    expect(screen.getByText('242 MB de 484 MB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Começar' })).toBeDisabled()
    await act(async () => {
      install.resolve(null)
    })
    await screen.findByText('Teste rápido do motor')
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    const order = [
      api.settings.update.mock.invocationCallOrder.at(-1)!,
      api.engine.selfTest.mock.invocationCallOrder[0]!
    ]
    expect(api.settings.update).toHaveBeenLastCalledWith({ model: 'small' })
    expect(order[0]!).toBeLessThan(order[1]!)
    const begin = await screen.findByRole('button', { name: 'Começar' })
    await vi.waitFor(() => {
      expect(begin).toBeEnabled()
    })
    expect(store.getState().onboarding).toBe(true)
    await expectAccessible(container)
    await user.click(begin)
    expect(store.getState().onboarding).toBe(false)
  })

  it('com GPU: aceita os termos, baixa o CUDA e passa a usar a GPU', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    api.system.info.mockResolvedValue(GPU)
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('checkbox', { name: /aceito os termos/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.settings.update.mock.calls.map((call) => call[0])).toEqual([
      { nvidiaTermsAccepted: true },
      { device: 'cuda' },
      { model: 'large-v3-turbo' }
    ])
    expect(api.cuda.install.mock.invocationCallOrder[0]!).toBeGreaterThan(
      api.models.install.mock.invocationCallOrder[0]!
    )
    act(() => {
      api.emitDownload({ type: 'progress', target: { kind: 'cuda' }, received: 1, total: 2 })
    })
    expect(screen.getByText('Bibliotecas da GPU NVIDIA')).toBeInTheDocument()
  })

  it('falha no download mostra o erro e "Tentar de novo" retoma', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    api.models.install.mockRejectedValueOnce(apiError('DOWNLOAD_FAILED', 'rede caiu'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('O download falhou')
    expect(screen.getByText('falhou')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.models.install).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('falha no teste do motor: tentar de novo não baixa outra vez', async () => {
    const api = new FakeApi({ model: null })
    api.engine.selfTest.mockRejectedValueOnce(apiError('WORKER_CRASHED'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('parou inesperadamente')
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalledTimes(2)
    })
    expect(api.models.install).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Começar' })).toBeEnabled()
  })

  it('mostra velocidade e tempo restante enquanto baixa', async () => {
    const api = new FakeApi({ model: null })
    api.models.install.mockReturnValue(new Promise(() => undefined))
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    const target = { kind: 'model', id: 'medium' } as const
    act(() => {
      api.emitDownload({ type: 'progress', target, received: 0, total: 3_000_000_000 })
    })
    now = 2000
    act(() => {
      api.emitDownload({ type: 'progress', target, received: 1_000_000_000, total: 3_000_000_000 })
    })
    expect(screen.getByText('500 MB/s · faltam 00:04')).toBeInTheDocument()
  })

  it('no StrictMode (dev) o download começa uma vez só', async () => {
    const api = new FakeApi({ model: null })
    const rendered = await renderWithApp(
      <StrictMode>
        <Onboarding />
      </StrictMode>,
      { api }
    )
    await rendered.user.click(screen.getByRole('button', { name: 'Continuar' }))
    await rendered.user.click(await screen.findByRole('button', { name: 'Baixar e continuar' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.models.install).toHaveBeenCalledTimes(1)
  })

  it('falha no download do CUDA mostra o progresso do CUDA e retoma só ele', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(GPU)
    api.cuda.install.mockRejectedValueOnce(apiError('HASH_MISMATCH'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('checkbox', { name: /aceito os termos/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('corrompido')
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.models.install).toHaveBeenCalledTimes(1)
    expect(api.cuda.install).toHaveBeenCalledTimes(2)
  })

  it('sem informações do sistema, recomenda o Medium e não oferece GPU', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    const { user } = await renderWithApp(<Onboarding />, { api, init: false })
    await user.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(await screen.findByRole('radio', { name: /Medium/ })).toBeChecked()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  })

  it('sem GPU grava a CPU (tentativa anterior pode ter deixado "cuda")', async () => {
    const api = new FakeApi({ model: null, device: 'cuda' })
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.settings.update).toHaveBeenCalledWith({ device: 'cpu' })
    expect(api.settings.update.mock.invocationCallOrder[0]!).toBeLessThan(
      api.engine.selfTest.mock.invocationCallOrder[0]!
    )
  })

  it('falhou (ex.: sem espaço): "Escolher outro modelo" volta e sem atalhos para as configurações', async () => {
    const api = new FakeApi({ model: null })
    api.installed = []
    api.models.install.mockRejectedValueOnce(apiError('INSUFFICIENT_SPACE'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('radio', { name: /^Large v3(?! Turbo)/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('espaço livre')
    expect(screen.queryByRole('button', { name: 'Abrir Armazenamento' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Escolher outro modelo' }))
    await user.click(await screen.findByRole('radio', { name: /Small/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await vi.waitFor(() => {
      expect(api.models.install).toHaveBeenLastCalledWith('small', 'ct2')
    })
  })

  it('GPU falhou no teste do motor: "Continuar na CPU" grava a CPU e termina', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(GPU)
    api.engine.selfTest.mockRejectedValueOnce(apiError('CUDA_FAILED'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('checkbox', { name: /aceito os termos/ }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await user.click(await screen.findByRole('button', { name: 'Continuar na CPU' }))
    expect(api.settings.update).toHaveBeenCalledWith({ device: 'cpu' })
    expect(await screen.findByRole('button', { name: 'Começar' })).toBeEnabled()
    expect(api.cuda.install).toHaveBeenCalledTimes(1)
  })

  it('sem GPU não oferece "Continuar na CPU"; o anel mostra onde o download parou', async () => {
    const api = new FakeApi({ model: null })
    let fail: (e: unknown) => void = () => undefined
    api.models.install.mockReturnValue(new Promise((_r, reject) => (fail = reject)))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    act(() => {
      api.emitDownload({
        type: 'progress',
        target: { kind: 'model', id: 'medium' },
        received: 3,
        total: 10
      })
    })
    await act(async () => {
      fail(apiError('DOWNLOAD_FAILED'))
      await Promise.resolve()
    })
    await screen.findByRole('alert')
    expect(screen.getByRole('progressbar', { name: 'Progresso do download' })).toHaveAttribute(
      'aria-valuenow',
      '30'
    )
    expect(screen.queryByRole('button', { name: 'Continuar na CPU' })).not.toBeInTheDocument()
  })

  it('GPU Intel/AMD/Apple: sem termos, baixa o modelo GGML e usa a GPU pelo whisper.cpp', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(INTEL)
    const { user } = await toModelStep(api)
    expect(screen.queryByText('Aceleração por GPU não disponível')).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Usar a GPU (Intel Iris Xe Graphics)' }))
    expect(screen.queryByRole('checkbox', { name: /aceito os termos/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await vi.waitFor(() => {
      expect(api.engine.selfTest).toHaveBeenCalled()
    })
    expect(api.models.install).toHaveBeenCalledWith('medium', 'ggml')
    expect(api.cuda.install).not.toHaveBeenCalled()
    expect(api.settings.update.mock.calls.map((c) => c[0])).toEqual([
      { device: 'gpu' },
      { model: 'medium' }
    ])
  })

  it('GPU pelo whisper.cpp falhou no teste: "Continuar na CPU" baixa o modelo da CPU e termina', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(INTEL)
    api.engine.selfTest.mockRejectedValueOnce(apiError('GPU_FAILED'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await user.click(await screen.findByRole('button', { name: 'Continuar na CPU' }))
    expect(await screen.findByRole('button', { name: 'Começar' })).toBeEnabled()
    expect(api.settings.update).toHaveBeenCalledWith({ device: 'cpu' })
    expect(api.models.install.mock.calls).toEqual([
      ['medium', 'ggml'],
      ['medium', 'ct2']
    ])
  })

  it('Mac Intel (sem Metal nem CUDA) explica que a GPU não é suportada', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue({
      ...SYSTEM_INFO,
      platform: 'darwin',
      arch: 'x64',
      cudaSupported: false
    })
    await toModelStep(api)
    expect(screen.getByText(/Este sistema não suporta a aceleração/)).toBeInTheDocument()
  })

  it('Apple Silicon: GPU pelo Metal; anel chega a 100% ao concluir e tamanho desconhecido mostra 0%', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue({
      ...INTEL,
      platform: 'darwin',
      arch: 'arm64',
      accelerator: { name: 'Apple M2', api: 'metal' }
    })
    let finish: () => void = () => undefined
    api.models.install.mockReturnValue(
      new Promise((resolve) => {
        finish = () => {
          resolve(null)
        }
      })
    )
    const { user } = await toModelStep(api)
    expect(screen.getByText(/placa de vídeo \(Metal\)/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Usar a GPU (Apple M2)' }))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    const target = { kind: 'model', id: 'medium', format: 'ggml' } as const
    const ring = screen.getByRole('progressbar', { name: 'Progresso do download' })
    act(() => {
      api.emitDownload({ type: 'progress', target, received: 0, total: 0 })
    })
    expect(ring).toHaveAttribute('aria-valuenow', '0')
    act(() => {
      api.emitDownload({ type: 'done', target })
    })
    expect(ring).toHaveAttribute('aria-valuenow', '100')
    await act(async () => {
      finish()
    })
    expect(await screen.findByRole('button', { name: 'Começar' })).toBeEnabled()
    expect(screen.getByRole('progressbar', { name: 'Progresso do download' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    )
  })

  it('"Continuar na CPU" que também falha mostra o erro de novo', async () => {
    const api = new FakeApi({ model: null })
    api.system.info.mockResolvedValue(INTEL)
    api.engine.selfTest.mockRejectedValueOnce(apiError('GPU_FAILED'))
    api.models.install.mockResolvedValueOnce(null).mockRejectedValueOnce(apiError('DISK_FULL'))
    const { user } = await toModelStep(api)
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'Baixar e continuar' }))
    await user.click(await screen.findByRole('button', { name: 'Continuar na CPU' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('O disco está cheio.')
  })
})
