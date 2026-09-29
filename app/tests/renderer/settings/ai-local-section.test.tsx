import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AiLocalSection } from '../../../src/renderer/src/screens/settings/AiLocalSection'
import { SettingsScreen } from '../../../src/renderer/src/screens/settings/SettingsScreen'
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_AI_STORAGE,
  DEFAULT_SETTINGS,
  type AiSettings,
  type Settings
} from '../../../src/shared/settings'
import { FakeApi } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const STATUS_OK = {
  configured: true,
  enabled: true,
  pendingAnalysis: 0,
  failedAnalysis: 0,
  totalAnalysis: 0,
  completedAnalysis: 0,
  index: { total: 0, completed: 0, pending: 0, failed: 0 },
  storage: null,
  blocked: null,
  reindexRequired: false
}

/** Digita e sai do campo: os campos da IA só salvam ao confirmar (blur/Enter). */
function commit(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } })
  fireEvent.blur(element)
}

function makeSettings(ai: Partial<AiSettings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_AI_SETTINGS, ...ai } }
}

describe('AiLocalSection — ligar e modos de análise', () => {
  it('liga a IA local e libera os interruptores de análise', async () => {
    const api = new FakeApi()
    const { user, container } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, {
      api
    })
    const incremental = screen.getByRole('switch', { name: 'Analisar durante a transcrição' })
    const final = screen.getByRole('switch', { name: 'Análise final ao terminar' })
    expect(incremental).toBeDisabled()
    expect(final).toBeDisabled()

    await user.click(screen.getByRole('switch', { name: 'Usar IA local (Ollama)' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, enabled: true }
    })
    await expectAccessible(container)
  })

  it('desliga os modos de análise com a IA ligada', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ enabled: true })} />,
      { api }
    )
    const incremental = screen.getByRole('switch', { name: 'Analisar durante a transcrição' })
    expect(incremental).toBeEnabled()
    await user.click(incremental)
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, enabled: true, incrementalAnalysisEnabled: false }
    })
    await user.click(screen.getByRole('switch', { name: 'Análise final ao terminar' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, enabled: true, finalAnalysisEnabled: false }
    })
  })
})

describe('AiLocalSection — conexão', () => {
  it('salva endereço, modelos e espaço de conhecimento', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    commit(screen.getByLabelText('Endereço do Ollama'), 'http://host:1234')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, ollamaUrl: 'http://host:1234' }
    })
    commit(screen.getByLabelText('Modelo de texto'), 'llama3:8b')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, llmModel: 'llama3:8b' }
    })
    commit(screen.getByLabelText('Modelo de embeddings'), 'mxbai-embed-large')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, embeddingModel: 'mxbai-embed-large' }
    })
    commit(screen.getByLabelText('Espaço de conhecimento'), 'trabalho')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, workspaceId: 'trabalho' }
    })
  })
})

describe('AiLocalSection — análise', () => {
  it('salva os números e ignora valores vazios ou infinitos', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    commit(screen.getByLabelText('Janela de análise (segundos)'), '60')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, analysisWindowSeconds: 60 }
    })
    commit(screen.getByLabelText('Sobreposição (segundos)'), '5')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, analysisOverlapSeconds: 5 }
    })
    commit(screen.getByLabelText('Análises ao mesmo tempo'), '2')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, maxConcurrentAnalysis: 2 }
    })
    commit(screen.getByLabelText('Tempo limite (segundos)'), '300')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, requestTimeoutSeconds: 300 }
    })

    const calls = api.settings.update.mock.calls.length
    commit(screen.getByLabelText('Janela de análise (segundos)'), '')
    expect(api.settings.update).toHaveBeenCalledTimes(calls)
  })
})

describe('SettingsScreen — seção IA local', () => {
  it('entra entre Ao vivo e IAs (MCP) e mostra a tela', async () => {
    const { user, store } = await renderWithApp(<SettingsScreen />)
    const nav = screen.getByRole('navigation', { name: 'Seções das configurações' })
    const labels = within(nav)
      .getAllByRole('button')
      .map((node) => node.textContent)
    expect(labels).toEqual([
      'Voltar',
      'Geral',
      'Transcrição',
      'Ao vivo',
      'IA local',
      'IAs (MCP)',
      'Armazenamento',
      'Ajuda',
      'Sobre',
      'Licenças'
    ])
    await user.click(within(nav).getByRole('button', { name: 'IA local' }))
    expect(store.getState().settingsSection).toBe('aiLocal')
    expect(screen.getByRole('heading', { name: 'Ollama' })).toBeInTheDocument()
  })
})

describe('AiLocalSection — armazenamento', () => {
  function withStorage(mode: 'external' | 'local') {
    return makeSettings({ storage: { ...DEFAULT_AI_STORAGE, mode } })
  }

  it('troca o backend e mostra só os campos do modo', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    expect(screen.queryByLabelText('Servidor')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Pasta de dados (volume)')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Backend'), 'external')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: {
        ...DEFAULT_AI_SETTINGS,
        storage: { ...DEFAULT_AI_STORAGE, mode: 'external' }
      }
    })
  })

  it('modo externo salva os campos e a senha no cofre', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={withStorage('external')} />, {
      api
    })
    commit(screen.getByLabelText('Servidor'), 'db.local')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: {
        ...DEFAULT_AI_SETTINGS,
        storage: {
          ...DEFAULT_AI_STORAGE,
          mode: 'external',
          postgres: { ...DEFAULT_AI_STORAGE.postgres, host: 'db.local' }
        }
      }
    })
    commit(screen.getByLabelText('Porta'), '6000')
    commit(screen.getByLabelText('Banco'), 'meu')
    commit(screen.getByLabelText('Usuário'), 'eu')
    commit(screen.getByLabelText('Modo SSL'), 'require')
    commit(screen.getByLabelText('Tempo limite de conexão (s)'), '30')

    await user.type(screen.getByLabelText('Senha do PostgreSQL'), 'segredo')
    expect(screen.getByText('Nenhuma senha guardada.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar senha' }))
    expect(api.ai.setSecret).toHaveBeenCalledWith('postgres', 'segredo')
  })

  it('modo local salva volume, imagem e a senha do container', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={withStorage('local')} />, {
      api
    })
    commit(screen.getByLabelText('Pasta de dados (volume)'), '/tmp/pg')
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: {
        ...DEFAULT_AI_SETTINGS,
        storage: { ...DEFAULT_AI_STORAGE, mode: 'local', volume: '/tmp/pg' }
      }
    })
    commit(screen.getByLabelText('Imagem do container'), 'pgvector/pgvector:pg17')
    await user.type(screen.getByLabelText('Senha do container'), 'senha')
    await user.click(screen.getByRole('button', { name: 'Salvar senha' }))
    expect(api.ai.setSecret).toHaveBeenCalledWith('container', 'senha')
  })

  it('senha já guardada mostra Remover e limpa', async () => {
    const api = new FakeApi()
    api.secretsValue = { available: true, postgres: true, container: false }
    const { user } = await renderWithApp(<AiLocalSection settings={withStorage('external')} />, {
      api
    })
    expect(await screen.findByText('Senha guardada no cofre do sistema.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remover senha' }))
    expect(api.ai.clearSecret).toHaveBeenCalledWith('postgres')
  })

  it('sem cofre avisa que a senha vale só na sessão', async () => {
    const api = new FakeApi()
    api.secretsValue = { available: false, postgres: false, container: false }
    await renderWithApp(<AiLocalSection settings={withStorage('local')} />, { api })
    expect(
      await screen.findByText(
        'O cofre do sistema não está disponível; a senha vale só nesta sessão.'
      )
    ).toBeInTheDocument()
  })
})

describe('AiLocalSection — cofre (casos extras)', () => {
  it('senha do container guardada também pode ser removida', async () => {
    const api = new FakeApi()
    api.secretsValue = { available: true, postgres: false, container: true }
    const { user } = await renderWithApp(
      <AiLocalSection
        settings={makeSettings({
          storage: { ...DEFAULT_AI_STORAGE, mode: 'local' }
        })}
      />,
      { api }
    )
    await user.click(await screen.findByRole('button', { name: 'Remover senha' }))
    expect(api.ai.clearSecret).toHaveBeenCalledWith('container')
  })

  it('falha ao ler o cofre não quebra a tela', async () => {
    const api = new FakeApi()
    api.ai.secretsStatus.mockRejectedValueOnce(new Error('sem cofre'))
    await renderWithApp(
      <AiLocalSection
        settings={makeSettings({ storage: { ...DEFAULT_AI_STORAGE, mode: 'external' } })}
      />,
      { api }
    )
    expect(screen.getByLabelText('Senha do PostgreSQL')).toBeInTheDocument()
  })
})

describe('AiLocalSection — diagnóstico', () => {
  it('executa e mostra as verificações', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Executar diagnóstico' }))
    const list = await screen.findByRole('list', { name: 'Diagnóstico' })
    expect(within(list).getByText('Ollama')).toBeInTheDocument()
    expect(within(list).getByText('http://localhost:11434 · 2 modelos')).toBeInTheDocument()
    expect(within(list).getByText('PostgreSQL')).toBeInTheDocument()
    expect(within(list).getByText('SQLite (fallback)')).toBeInTheDocument()
  })

  it('verificação sem detalhe só mostra o nome', async () => {
    const api = new FakeApi()
    api.aiDiagnostics.mockResolvedValue([{ name: 'rag', ok: false, detail: null }])
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Executar diagnóstico' }))
    expect(await screen.findByText('RAG')).toBeInTheDocument()
  })

  it('falha vira aviso e não lista', async () => {
    const api = new FakeApi()
    api.aiDiagnostics.mockRejectedValueOnce(new Error('sem ia'))
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Executar diagnóstico' }))
    expect(screen.queryByRole('list', { name: 'Diagnóstico' })).not.toBeInTheDocument()
  })
})

describe('AiLocalSection — reindexar', () => {
  it('fica desabilitado com a IA desligada', async () => {
    await renderWithApp(<AiLocalSection settings={makeSettings()} />)
    expect(screen.getByRole('button', { name: 'Reindexar conhecimento' })).toBeDisabled()
    expect(screen.getByText('Ligue a IA local para reindexar.')).toBeInTheDocument()
  })

  it('reindexa e mostra o total', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ enabled: true })} />,
      { api }
    )
    await user.click(screen.getByRole('button', { name: 'Reindexar conhecimento' }))
    expect(api.ai.reindex).toHaveBeenCalled()
    expect(await screen.findByText('3 itens reindexados.')).toBeInTheDocument()
  })

  it('falha vira aviso e não mostra total', async () => {
    const api = new FakeApi()
    api.aiReindex.mockRejectedValueOnce(new Error('falhou'))
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ enabled: true })} />,
      { api }
    )
    await user.click(screen.getByRole('button', { name: 'Reindexar conhecimento' }))
    expect(screen.queryByText(/reindexados/)).not.toBeInTheDocument()
  })

  it('mostra o progresso e permite cancelar', async () => {
    const api = new FakeApi()
    let finish: (count: number) => void = () => undefined
    api.aiReindex.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve
      })
    )
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ enabled: true })} />,
      { api }
    )
    await user.click(screen.getByRole('button', { name: 'Reindexar conhecimento' }))
    act(() => {
      api.aiReindexListener?.({ completed: 2, total: 4 })
    })
    expect(await screen.findByText('Reindexando… 50% (2/4)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(api.ai.cancelReindex).toHaveBeenCalled()

    act(() => {
      finish(3)
    })
    expect(await screen.findByText('3 itens reindexados.')).toBeInTheDocument()
  })
})

describe('AiLocalSection — backup e restore', () => {
  it('faz backup e mostra o total', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Fazer backup' }))
    expect(api.ai.backup).toHaveBeenCalled()
    expect(await screen.findByText('Backup: 2 documentos, 1 análises.')).toBeInTheDocument()
  })

  it('restaura e mostra o total', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Restaurar' }))
    expect(api.ai.restore).toHaveBeenCalled()
    expect(await screen.findByText('2 documentos e 1 análises restaurados.')).toBeInTheDocument()
  })

  it('cancelar não mostra mensagem', async () => {
    const api = new FakeApi()
    api.aiBackup.mockResolvedValueOnce(null)
    api.aiRestore.mockResolvedValueOnce(null)
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Fazer backup' }))
    await user.click(screen.getByRole('button', { name: 'Restaurar' }))
    expect(screen.queryByText(/documentos/)).not.toBeInTheDocument()
  })

  it('falha vira aviso e não mostra total', async () => {
    const api = new FakeApi()
    api.aiBackup.mockRejectedValueOnce(new Error('disco'))
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Fazer backup' }))
    expect(screen.queryByText(/Backup:/)).not.toBeInTheDocument()
  })
})

describe('AiLocalSection — baixar modelos', () => {
  it('baixa o modelo de texto configurado', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    const buttons = screen.getAllByRole('button', { name: 'Baixar modelo' })
    await user.click(buttons[0]!)
    expect(api.ai.pullModel).toHaveBeenCalledWith('qwen3:8b')
    expect(await screen.findByText('qwen3:8b pronto.')).toBeInTheDocument()
  })

  it('baixa o modelo de embeddings configurado', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    const buttons = screen.getAllByRole('button', { name: 'Baixar modelo' })
    await user.click(buttons[1]!)
    expect(api.ai.pullModel).toHaveBeenCalledWith('nomic-embed-text')
    expect(await screen.findByText('nomic-embed-text pronto.')).toBeInTheDocument()
  })

  it('falha ao baixar não confirma o modelo', async () => {
    const api = new FakeApi()
    api.aiPullModel.mockRejectedValueOnce(new Error('rede'))
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getAllByRole('button', { name: 'Baixar modelo' })[0]!)
    expect(screen.queryByText(/pronto/)).not.toBeInTheDocument()
  })

  it('não baixa quando o nome do modelo está vazio', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ llmModel: '  ' })} />,
      { api }
    )
    await user.click(screen.getAllByRole('button', { name: 'Baixar modelo' })[0]!)
    expect(api.ai.pullModel).not.toHaveBeenCalled()
  })

  it('mostra o progresso do download', async () => {
    const api = new FakeApi()
    let finish: (value: { model: string }) => void = () => undefined
    api.aiPullModel.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getAllByRole('button', { name: 'Baixar modelo' })[0]!)
    act(() => {
      api.emitAiEvent({ type: 'pull', model: 'qwen3:8b', completed: 1, total: 2 })
    })
    expect(await screen.findByText('Baixando… 50%')).toBeInTheDocument()

    act(() => {
      finish({ model: 'qwen3:8b' })
    })
    expect(await screen.findByText('qwen3:8b pronto.')).toBeInTheDocument()
  })
})

describe('AiLocalSection — edição dos campos', () => {
  it('digitar não salva a cada tecla: só ao sair do campo ou com Enter', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    const window = screen.getByLabelText('Janela de análise (segundos)')
    fireEvent.change(window, { target: { value: '6' } }) // passaria por "6" < sobreposição
    fireEvent.change(window, { target: { value: '60' } })
    expect(api.settings.update).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: { ...DEFAULT_AI_SETTINGS, analysisWindowSeconds: 60 }
    })
  })

  it('campo obrigatório vazio mostra o erro e não salva; Esc desfaz', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    const url = screen.getByLabelText('Endereço do Ollama')
    commit(url, '')
    expect(screen.getByRole('alert')).toHaveTextContent('Preencha este campo.')
    expect(api.settings.update).not.toHaveBeenCalled()
    fireEvent.keyDown(url, { key: 'Escape' })
    expect(url).toHaveValue(DEFAULT_AI_SETTINGS.ollamaUrl)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('valida número, mínimo e a sobreposição menor que a janela', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    commit(screen.getByLabelText('Análises ao mesmo tempo'), '0')
    expect(screen.getByRole('alert')).toHaveTextContent('O mínimo é 1.')
    commit(screen.getByLabelText('Análises ao mesmo tempo'), '2')
    commit(screen.getByLabelText('Sobreposição (segundos)'), '45')
    expect(screen.getByRole('alert')).toHaveTextContent('menor que a janela')
    commit(screen.getByLabelText('Tempo limite (segundos)'), 'abc')
    expect(screen.getAllByRole('alert').at(-1)).toHaveTextContent('Digite um número.')
    expect(api.settings.update).toHaveBeenCalledTimes(1) // só o "2" válido
  })

  it('valor que mudou por fora aparece no campo', async () => {
    const api = new FakeApi()
    const { rerender } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, {
      api
    })
    rerender(<AiLocalSection settings={makeSettings({ llmModel: 'llama3:8b' })} />)
    expect(screen.getByLabelText('Modelo de texto')).toHaveValue('llama3:8b')
  })
})

describe('AiLocalSection — Ollama remoto', () => {
  it('avisa quando o endereço sai desta máquina e permite liberar', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(
      <AiLocalSection settings={makeSettings({ ollamaUrl: 'http://gpu.example.com:11434' })} />,
      { api }
    )
    expect(screen.getByText(/gpu\.example\.com/)).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Permitir Ollama remoto' }))
    expect(api.settings.update).toHaveBeenLastCalledWith({
      ai: {
        ...DEFAULT_AI_SETTINGS,
        ollamaUrl: 'http://gpu.example.com:11434',
        allowRemoteOllama: true
      }
    })
  })

  it('endereço local não mostra aviso', async () => {
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api: new FakeApi() })
    expect(screen.queryByText(/sairão desta máquina/)).not.toBeInTheDocument()
  })
})

describe('AiLocalSection — modo automático e reindexação', () => {
  it('modo automático mostra o volume e explica a senha gerada', async () => {
    await renderWithApp(
      <AiLocalSection
        settings={makeSettings({ storage: { ...DEFAULT_AI_STORAGE, mode: 'auto' } })}
      />,
      { api: new FakeApi() }
    )
    expect(screen.getByLabelText('Pasta de dados (volume)')).toBeInTheDocument()
    expect(screen.getByText(/senha é gerada/)).toBeInTheDocument()
  })

  it('avisa quando o modelo de embeddings mudou e pede reindexação', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({ ...(await api.aiStatus()), reindexRequired: true })
    await renderWithApp(<AiLocalSection settings={makeSettings({ enabled: true })} />, { api })
    expect(await screen.findByText(/Reindexe o conhecimento/)).toBeInTheDocument()
  })
})

describe('AiLocalSection — casos de borda', () => {
  it('sair do campo sem mudar nada não salva', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    fireEvent.blur(screen.getByLabelText('Endereço do Ollama'))
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('janela menor ou igual à sobreposição é recusada', async () => {
    const api = new FakeApi()
    await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    commit(screen.getByLabelText('Janela de análise (segundos)'), '10')
    expect(screen.getByRole('alert')).toHaveTextContent('maior que a sobreposição')
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('endereço inválido não mostra aviso de remoto', async () => {
    await renderWithApp(<AiLocalSection settings={makeSettings({ ollamaUrl: 'não é url' })} />, {
      api: new FakeApi()
    })
    expect(screen.queryByText(/sairão desta máquina/)).not.toBeInTheDocument()
  })

  it('status que falha não quebra; evento de status atualiza o aviso de reindexação', async () => {
    const api = new FakeApi()
    api.aiStatus.mockRejectedValueOnce(new Error('sem ia'))
    await renderWithApp(<AiLocalSection settings={makeSettings({ enabled: true })} />, { api })
    expect(screen.queryByText(/Reindexe o conhecimento/)).not.toBeInTheDocument()
    act(() => {
      api.emitAiEvent({ type: 'status', status: { ...STATUS_OK, reindexRequired: true } })
      api.emitAiEvent({ type: 'search', results: [] })
    })
    expect(await screen.findByText(/Reindexe o conhecimento/)).toBeInTheDocument()
  })
})

describe('AiLocalSection — ajuda do Ollama', () => {
  it('explica os passos e mostra os comandos dos modelos', async () => {
    await renderWithApp(<AiLocalSection settings={makeSettings()} />)
    expect(screen.getByRole('heading', { name: 'Como configurar o Ollama' })).toBeInTheDocument()
    expect(screen.getByText(/ollama pull qwen3:8b/)).toBeInTheDocument()
    expect(screen.getByText(/ollama pull nomic-embed-text/)).toBeInTheDocument()
    expect(screen.getByText(/qwen3:4b/)).toBeInTheDocument()
  })

  it('abre a página de download do Ollama', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Baixar o Ollama' }))
    expect(api.system.openExternal).toHaveBeenCalledWith('https://ollama.com/download')
  })

  it('copia os comandos de download', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiLocalSection settings={makeSettings()} />, { api })
    await user.click(screen.getByRole('button', { name: 'Copiar comandos' }))
    expect(api.clipboard.write).toHaveBeenCalledWith(
      'ollama pull qwen3:8b\nollama pull nomic-embed-text'
    )
    expect(await screen.findByText('Copiado!')).toBeInTheDocument()
  })
})
