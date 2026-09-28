import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlayerProvider } from '../../../src/renderer/src/hooks/usePlayer'
import { IntelligencePanel } from '../../../src/renderer/src/screens/main/IntelligencePanel'
import type { HistoryMeta } from '../../../src/shared/history'
import type { AiAnalysis, AiStatus } from '../../../src/shared/ipc'
import { FakeApi } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const ID = '11111111-1111-4111-8111-111111111111'

const STATUS: AiStatus = {
  configured: true,
  enabled: true,
  pendingAnalysis: 0,
  failedAnalysis: 0,
  index: { total: 2, completed: 2, pending: 0, failed: 0 },
  storage: { kind: 'sqlite', fallback: false, reason: null },
  blocked: null,
  reindexRequired: false
}

const ANALYSIS: AiAnalysis = {
  summary: 'Reunião sobre sincronização',
  model: 'qwen',
  items: [
    {
      id: 't1',
      kind: 'topic',
      text: 'Sincronização',
      detail: null,
      confidence: 0.9,
      state: null,
      start: 12,
      end: 20
    },
    {
      id: 'k1',
      kind: 'task',
      text: 'Corrigir bug',
      detail: 'Ana',
      confidence: 0.5,
      state: 'UPDATED',
      start: null,
      end: null
    },
    {
      id: 'p1',
      kind: 'person',
      text: 'Ana',
      detail: 'QA',
      confidence: 0.8,
      state: null,
      start: 3,
      end: 5
    }
  ]
}

function setup(api = new FakeApi(), transcriptionStatus: HistoryMeta['status'] = 'done') {
  return renderWithApp(
    <PlayerProvider>
      <IntelligencePanel transcriptionId={ID} transcriptionStatus={transcriptionStatus} />
    </PlayerProvider>,
    { api }
  )
}

describe('IntelligencePanel', () => {
  it('mostra o status, as seções e permite pular para o tempo', async () => {
    const api = new FakeApi()
    api.aiAnalysis.mockResolvedValue(ANALYSIS)
    const { user, container } = await setup(api)
    expect(await screen.findByText('Análise: 0 pendentes · Indexação: 100%')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tópicos' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tarefas' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Pessoas' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Resumo' })).toBeInTheDocument()
    expect(screen.getByText('Reunião sobre sincronização')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Decisões' })).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: /Sincronização/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Corrigir bug/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Sincronização/ }))
    expect(screen.getByText('QA')).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('atualiza ao vivo com os eventos da IA', async () => {
    const api = new FakeApi()
    await setup(api)
    const live: AiStatus = {
      configured: true,
      enabled: true,
      pendingAnalysis: 1,
      failedAnalysis: 0,
      index: { total: 1, completed: 0, pending: 1, failed: 0 },
      storage: null,
      blocked: null,
      reindexRequired: false
    }
    act(() => {
      api.emitAiEvent({ type: 'status', status: live })
    })
    expect(await screen.findByText('Análise: 1 pendentes · Indexação: 0%')).toBeInTheDocument()

    act(() => {
      api.emitAiEvent({ type: 'search', results: [] })
    })
    act(() => {
      api.emitAiEvent({
        type: 'analysis',
        transcriptionId: 'outro',
        analysis: ANALYSIS,
        final: true
      })
    })
    expect(screen.queryByText('Reunião sobre sincronização')).not.toBeInTheDocument()

    act(() => {
      api.emitAiEvent({ type: 'analysis', transcriptionId: ID, analysis: ANALYSIS, final: true })
    })
    expect(await screen.findByText('Reunião sobre sincronização')).toBeInTheDocument()
  })

  it('mostra o estado desligado', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({ ...STATUS, enabled: false })
    await setup(api)
    expect(await screen.findByText('IA local desligada.')).toBeInTheDocument()
  })

  it('avisa o fallback e indexação zerada', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({
      ...STATUS,
      index: { total: 0, completed: 0, pending: 0, failed: 0 },
      storage: { kind: 'sqlite', fallback: true, reason: 'sem docker' }
    })
    await setup(api)
    expect(await screen.findByText('Usando SQLite (sem docker).')).toBeInTheDocument()
    expect(screen.getByText('Análise: 0 pendentes · Indexação: 100%')).toBeInTheDocument()
  })

  it('fallback sem motivo usa a mensagem genérica', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({
      ...STATUS,
      storage: { kind: 'sqlite', fallback: true, reason: null }
    })
    await setup(api)
    expect(await screen.findByText('Usando SQLite (fallback).')).toBeInTheDocument()
  })

  it('sem análise mostra o aviso e o botão atualiza', async () => {
    const api = new FakeApi()
    const { user } = await setup(api)
    expect(
      await screen.findByText('Sem análise ainda. Ligue a IA local nas Configurações.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Atualizar' }))
    expect(api.aiAnalysis).toHaveBeenCalledTimes(2)
    expect(api.aiStatus).toHaveBeenCalledTimes(2)
  })

  it('falha ao carregar mostra o erro (e não "sem análise")', async () => {
    const api = new FakeApi()
    api.aiAnalysis.mockRejectedValueOnce({ code: 'AI_BLOCKED', message: 'remoto' })
    await setup(api)
    expect(await screen.findByRole('alert')).toHaveTextContent('fora desta máquina')
    expect(
      screen.queryByText('Sem análise ainda. Ligue a IA local nas Configurações.')
    ).not.toBeInTheDocument()
  })
})

describe('IntelligencePanel — resumo', () => {
  it('mostra só o resumo quando não há entidades', async () => {
    const api = new FakeApi()
    api.aiAnalysis.mockResolvedValue({ summary: 'Curto resumo', items: [], model: null })
    await setup(api)
    expect(await screen.findByRole('heading', { name: 'Resumo' })).toBeInTheDocument()
    expect(screen.getByText('Curto resumo')).toBeInTheDocument()
    expect(
      screen.queryByText('Sem análise ainda. Ligue a IA local nas Configurações.')
    ).not.toBeInTheDocument()
  })
})

describe('IntelligencePanel — acompanhamento', () => {
  it('mostra a transcrição em andamento e a análise parcial', async () => {
    const api = new FakeApi()
    await setup(api, 'processing')
    expect(await screen.findByText('Transcrição: em andamento')).toBeInTheDocument()
    act(() => {
      api.emitAiEvent({ type: 'analysis', transcriptionId: ID, analysis: ANALYSIS, final: false })
    })
    expect(await screen.findByText(/Análise parcial/)).toBeInTheDocument()
    act(() => {
      api.emitAiEvent({ type: 'analysis', transcriptionId: ID, analysis: ANALYSIS, final: true })
    })
    expect(screen.queryByText(/Análise parcial/)).not.toBeInTheDocument()
  })

  it('mostra o estado das entidades atualizadas/confirmadas', async () => {
    const api = new FakeApi()
    api.aiAnalysis.mockResolvedValue(ANALYSIS)
    await setup(api)
    expect(await screen.findByText('atualizada')).toBeInTheDocument()
  })

  it('bloqueio e reindexação necessária aparecem no topo', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({
      ...STATUS,
      blocked: 'Ollama fora da rede local',
      reindexRequired: true
    })
    await setup(api)
    expect(await screen.findByText('Ollama fora da rede local')).toBeInTheDocument()
    expect(screen.getByText(/Reindexe o conhecimento/)).toBeInTheDocument()
  })

  it('janelas que falharam podem ser tentadas de novo', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({ ...STATUS, failedAnalysis: 2 })
    const { user } = await setup(api)
    await user.click(await screen.findByRole('button', { name: 'Tentar de novo (2)' }))
    expect(api.aiRetry).toHaveBeenCalledWith(ID)
  })

  it('reanalisa a transcrição', async () => {
    const api = new FakeApi()
    const { user } = await setup(api)
    await user.click(await screen.findByRole('button', { name: 'Reanalisar' }))
    expect(api.aiReanalyze).toHaveBeenCalledWith(ID)
  })
})

describe('IntelligencePanel — perguntas', () => {
  it('pergunta ao conhecimento e a fonte leva ao trecho', async () => {
    const api = new FakeApi()
    api.aiAsk.mockResolvedValue({
      answer: 'A Ana faz o deploy.',
      model: 'qwen3:8b',
      sources: [
        { transcriptionId: ID, title: 'Reunião', text: 'Ana faz o deploy', start: 30, end: 35 },
        { transcriptionId: 'outra', title: 'Outra reunião', text: 'deploy', start: 5, end: 6 },
        { transcriptionId: null, title: null, text: 'trecho solto', start: null, end: null }
      ]
    })
    const { user, container } = await setup(api)
    await user.type(
      await screen.findByLabelText('Pergunte sobre suas transcrições'),
      'Quem faz o deploy?'
    )
    await user.click(screen.getByRole('button', { name: 'Perguntar' }))
    expect(api.aiAsk).toHaveBeenCalledWith('Quem faz o deploy?')
    expect(await screen.findByText('A Ana faz o deploy.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Ana faz o deploy/ }))
    expect(screen.getByText(/Outra reunião/)).toBeInTheDocument()
    await expectAccessible(container)
  })

  it('erro na pergunta aparece no painel', async () => {
    const api = new FakeApi()
    api.aiAsk.mockRejectedValue({ code: 'AI_DISABLED', message: 'off' })
    const { user } = await setup(api)
    await user.type(await screen.findByLabelText('Pergunte sobre suas transcrições'), 'algo')
    await user.click(screen.getByRole('button', { name: 'Perguntar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('desligada')
  })
})

describe('IntelligencePanel — falhas nas ações', () => {
  it('falha ao tentar de novo aparece no painel', async () => {
    const api = new FakeApi()
    api.aiStatus.mockResolvedValue({ ...STATUS, failedAnalysis: 1 })
    api.aiRetry.mockRejectedValue({ code: 'AI_NOT_CONFIGURED', message: 'x' })
    const { user } = await setup(api)
    await user.click(await screen.findByRole('button', { name: 'Tentar de novo (1)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('não está configurada')
  })
})

describe('IntelligencePanel — detalhes', () => {
  it('tarefa cancelada aparece riscada com o estado', async () => {
    const api = new FakeApi()
    api.aiAnalysis.mockResolvedValue({
      summary: null,
      model: null,
      items: [
        {
          id: 'c1',
          kind: 'task',
          text: 'Migrar banco',
          detail: null,
          confidence: 0.5,
          state: 'CANCELLED',
          start: null,
          end: null
        }
      ]
    })
    await setup(api)
    expect(await screen.findByText('Migrar banco')).toHaveClass('line-through')
    expect(screen.getByText('cancelada')).toBeInTheDocument()
  })

  it('pergunta só com espaços não é enviada (nem com Enter)', async () => {
    const api = new FakeApi()
    const { user } = await setup(api)
    await user.type(await screen.findByLabelText('Pergunte sobre suas transcrições'), '   {Enter}')
    expect(api.aiAsk).not.toHaveBeenCalled()
  })
})
