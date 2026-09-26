import { act, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { formatRelative } from '../../../src/renderer/src/lib/relative-time'
import { AiSection } from '../../../src/renderer/src/screens/settings/AiSection'
import { SettingsScreen } from '../../../src/renderer/src/screens/settings/SettingsScreen'
import type { McpStatus } from '../../../src/shared/ipc'
import {
  MCP_CLIENT_IDS,
  MCP_CLIENT_NAMES,
  type ClientStatus,
  type McpClientId
} from '../../../src/shared/mcp'
import { apiError, FakeApi } from '../fake-api'
import { expectAccessible, renderWithApp } from '../render'

const NOW = Date.UTC(2026, 8, 26, 15, 0, 0)
const now = (): number => NOW
const LAUNCHER = '/home/u/.config/Whisper Transcriber/mcp/whisper-transcriber-mcp'

function client(patch: Partial<ClientStatus> & { id: McpClientId }): ClientStatus {
  return {
    name: MCP_CLIENT_NAMES[patch.id],
    state: 'found',
    lastUsedAt: null,
    restartNeeded: false,
    manual: { kind: 'json', text: `manual de ${patch.id}` },
    ...patch
  }
}

function statusWith(clients: ClientStatus[], patch: Partial<McpStatus> = {}): McpStatus {
  return {
    launcherOk: true,
    launcherError: null,
    launcherPath: LAUNCHER,
    bridgeOk: true,
    clients,
    ...patch
  }
}

function card(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('li')!
}

describe('formatRelative', () => {
  it('escolhe a unidade pelo intervalo', () => {
    const at = (ms: number): string => new Date(NOW - ms).toISOString()
    expect(formatRelative(at(5_000), NOW, 'pt-BR')).toBe('há 5 seg.')
    expect(formatRelative(at(2 * 60_000), NOW, 'pt-BR')).toBe('há 2 min.')
    expect(formatRelative(at(2 * 3_600_000), NOW, 'pt-BR')).toBe('há 2 h')
    expect(formatRelative(at(2 * 86_400_000), NOW, 'pt-BR')).toBe('anteontem')
    expect(formatRelative(at(60 * 86_400_000), NOW, 'pt-BR')).toBe('há 2 meses')
    expect(formatRelative(at(800 * 86_400_000), NOW, 'pt-BR')).toBe('há 2 anos')
    expect(formatRelative(new Date(NOW + 3_600_000).toISOString(), NOW, 'en')).toBe('in 1 hr.')
  })
})

describe('AiSection — acesso', () => {
  it('carrega o status ao abrir e liga/desliga as chaves', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    expect(api.mcpStatus).toHaveBeenCalledTimes(1)
    const enabled = screen.getByRole('switch', {
      name: 'Permitir que IAs leiam minhas transcrições'
    })
    expect(
      screen.getByRole('switch', { name: 'Permitir que IAs transcrevam arquivos' })
    ).toBeDisabled()
    await user.click(enabled)
    expect(api.settings.update).toHaveBeenLastCalledWith({
      mcp: { enabled: true, allowTranscribe: true }
    })
  })

  it('com o acesso ligado a chave de transcrever funciona', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    const transcribe = screen.getByRole('switch', {
      name: 'Permitir que IAs transcrevam arquivos'
    })
    expect(transcribe).toBeEnabled()
    await user.click(transcribe)
    expect(api.settings.update).toHaveBeenLastCalledWith({
      mcp: { enabled: true, allowTranscribe: false }
    })
  })

  it('mostra Pronto com o número de conectadas, Desligado e Com problema', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({ id: 'codex', state: 'connected' }),
        client({ id: 'cursor', state: 'connected' })
      ])
    )
    const { unmount } = await renderWithApp(<AiSection now={now} />, { api })
    expect(await screen.findByText('Pronto · 2 IAs conectadas')).toBeInTheDocument()
    unmount()

    await renderWithApp(<AiSection now={now} />, { api: new FakeApi() })
    expect(await screen.findByText('Desligado')).toBeInTheDocument()

    const broken = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    broken.mcpStatus.mockResolvedValue(
      statusWith([], { launcherOk: false, launcherError: 'sem permissão de escrita' })
    )
    await renderWithApp(<AiSection now={now} />, { api: broken })
    expect(await screen.findByText('Com problema: sem permissão de escrita')).toBeInTheDocument()
  })

  it('falha ao carregar o status não quebra a tela', async () => {
    const api = new FakeApi()
    api.mcpStatus.mockRejectedValue(new Error('sem status'))
    await renderWithApp(<AiSection now={now} />, { api })
    expect(await screen.findByText('Desligado')).toBeInTheDocument()
  })

  it('sem configurações carregadas não renderiza', async () => {
    const { container } = await renderWithApp(<AiSection now={now} />, { init: false })
    expect(container).toBeEmptyDOMElement()
  })

  it('testa a conexão: carregando, funcionando e falha', async () => {
    const api = new FakeApi()
    let finish: (value: { ok: true; tools: number }) => void = () => undefined
    api.mcpTest.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    await user.click(screen.getByRole('button', { name: 'Testar conexão' }))
    expect(screen.getByRole('button', { name: 'Testando…' })).toBeDisabled()
    await act(async () => {
      finish({ ok: true, tools: 8 })
    })
    expect(await screen.findByText('Funcionando (8 ferramentas)')).toBeInTheDocument()

    api.mcpTest.mockRejectedValueOnce(apiError('APP_START_TIMEOUT', 'demorou'))
    await user.click(screen.getByRole('button', { name: 'Testar conexão' }))
    expect(await screen.findByText('Falhou: demorou')).toBeInTheDocument()
  })
})

describe('AiSection — cartões', () => {
  it('mostra os clientes na ordem e cada estado', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({
          id: 'claude-code',
          state: 'connected',
          lastUsedAt: new Date(NOW - 3 * 60_000).toISOString()
        }),
        client({ id: 'claude-desktop', state: 'connected', restartNeeded: true }),
        client({ id: 'codex', state: 'found' }),
        client({ id: 'opencode', state: 'missing' })
      ])
    )
    await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Claude Code' })

    const order = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)
    expect(order).toEqual(MCP_CLIENT_IDS.slice(0, 4).map((id) => MCP_CLIENT_NAMES[id]))
    expect(within(card('Claude Code')).getByText('Conectado · usado há 3 min.')).toBeInTheDocument()
    expect(
      within(card('Claude Desktop')).getByText('Conectado · reinicie o Claude Desktop para usar')
    ).toBeInTheDocument()
    expect(within(card('Codex')).getByRole('button', { name: 'Conectar' })).toBeInTheDocument()
    expect(
      within(card('OpenCode')).queryByRole('button', { name: 'Conectar' })
    ).not.toBeInTheDocument()
    expect(
      within(card('OpenCode')).getByRole('button', { name: 'Config manual' })
    ).toBeInTheDocument()
  })

  it('conecta e desconecta, recarregando o status', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({ id: 'codex', state: 'found' }),
        client({ id: 'cursor', state: 'connected' })
      ])
    )
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    await user.click(within(card('Codex')).getByRole('button', { name: 'Conectar' }))
    expect(api.mcpConnect).toHaveBeenCalledWith('codex')
    await user.click(within(card('Cursor')).getByRole('button', { name: 'Desconectar' }))
    expect(api.mcpDisconnect).toHaveBeenCalledWith('cursor')
    expect(api.mcpStatus).toHaveBeenCalledTimes(3) // abertura + 2 ações
  })

  it('mostra carregando e bloqueia o botão enquanto a ação roda', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({ id: 'codex', state: 'found' }),
        client({ id: 'cursor', state: 'connected' })
      ])
    )
    let releaseConnect: () => void = () => undefined
    api.mcpConnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConnect = () => {
            resolve(client({ id: 'codex' }))
          }
        })
    )
    let releaseDisconnect: () => void = () => undefined
    api.mcpDisconnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDisconnect = () => {
            resolve(client({ id: 'cursor' }))
          }
        })
    )
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    await user.click(within(card('Codex')).getByRole('button', { name: 'Conectar' }))
    expect(within(card('Codex')).getByRole('button', { name: 'Conectando…' })).toBeDisabled()
    await act(async () => {
      releaseConnect()
    })
    await user.click(within(card('Cursor')).getByRole('button', { name: 'Desconectar' }))
    expect(within(card('Cursor')).getByRole('button', { name: 'Desconectando…' })).toBeDisabled()
    await act(async () => {
      releaseDisconnect()
    })
  })

  it('erro de configuração aparece no cartão com a config manual aberta', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({
          id: 'codex',
          state: 'found',
          error: { code: 'CONFIG_INVALID', message: 'broken' },
          manual: { kind: 'toml', text: 'command = "/lancador"' }
        })
      ])
    )
    await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    const codex = card('Codex')
    expect(
      within(codex).getByText(
        'O arquivo de configuração do Codex tem um erro; use a config manual.'
      )
    ).toBeInTheDocument()
    expect(within(codex).getByText('command = "/lancador"')).toBeInTheDocument()
  })

  it('erro de uma ação aparece no cartão com a config manual aberta', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(statusWith([client({ id: 'codex', state: 'found' })]))
    api.mcpConnect.mockRejectedValueOnce(apiError('CLIENT_CLI_FAILED', 'o comando falhou'))
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    await user.click(within(card('Codex')).getByRole('button', { name: 'Conectar' }))
    expect(await within(card('Codex')).findByText('o comando falhou')).toBeInTheDocument()
    expect(within(card('Codex')).getByText('manual de codex')).toBeInTheDocument()
  })

  it('mostra o aviso de config com comentários', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(
      statusWith([
        client({
          id: 'opencode',
          state: 'found',
          error: { code: 'CONFIG_HAS_COMMENTS', message: 'x' }
        })
      ])
    )
    await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'OpenCode' })
    expect(
      within(card('OpenCode')).getByText(
        'O arquivo do OpenCode tem comentários; para não perdê-los, use a config manual.'
      )
    ).toBeInTheDocument()
  })

  it('expande a config manual e copia', async () => {
    const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true } })
    api.mcpStatus.mockResolvedValue(statusWith([client({ id: 'codex', state: 'found' })]))
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    const codex = card('Codex')
    await user.click(within(codex).getByRole('button', { name: 'Config manual' }))
    expect(within(codex).getByText('manual de codex')).toBeInTheDocument()
    await user.click(within(codex).getByRole('button', { name: 'Copiar' }))
    expect(api.clipboard.write).toHaveBeenCalledWith('manual de codex')
    expect(within(codex).getByRole('button', { name: '✓ Copiado' })).toBeInTheDocument()
  })

  it('primeiro Conectar com o acesso desligado pede confirmação', async () => {
    const api = new FakeApi()
    api.mcpStatus.mockResolvedValue(statusWith([client({ id: 'codex', state: 'found' })]))
    const { user, container } = await renderWithApp(<AiSection now={now} />, { api })
    await screen.findByRole('heading', { name: 'Codex' })
    await user.click(within(card('Codex')).getByRole('button', { name: 'Conectar' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Permitir acesso?' })
    expect(dialog).toHaveTextContent('Você pode desligar quando quiser.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(api.mcpConnect).not.toHaveBeenCalled()
    await user.click(within(card('Codex')).getByRole('button', { name: 'Conectar' }))
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Permitir e conectar' })
    )
    expect(api.mcpConnect).toHaveBeenCalledWith('codex')
    await expectAccessible(container)
  })
})

describe('AiSection — blocos finais', () => {
  it('Outra IA mostra o comando e o JSON genérico, com Copiar', async () => {
    const api = new FakeApi()
    const { user } = await renderWithApp(<AiSection now={now} />, { api })
    const other = screen.getByRole('heading', { name: 'Outra IA' }).closest('section')!
    expect(await within(other).findByText(LAUNCHER)).toBeInTheDocument()
    expect(within(other).getByText(/"mcpServers"/)).toBeInTheDocument()
    await user.click(within(other).getByRole('button', { name: 'Copiar comando' }))
    expect(api.clipboard.write).toHaveBeenLastCalledWith(LAUNCHER)
    await user.click(within(other).getByRole('button', { name: 'Copiar JSON' }))
    expect(api.clipboard.write).toHaveBeenLastCalledWith(expect.stringContaining('"mcpServers"'))
  })

  it('explica por que ChatGPT e claude.ai web não são suportados', async () => {
    await renderWithApp(<AiSection now={now} />)
    expect(screen.getByRole('heading', { name: 'ChatGPT e claude.ai (web)' })).toBeInTheDocument()
    expect(screen.getByText(/rodam na nuvem/)).toBeInTheDocument()
  })

  it('atividade recente: até 50 linhas traduzidas e vazio', async () => {
    const empty = new FakeApi()
    empty.mcpActivity.mockResolvedValue([])
    const { unmount } = await renderWithApp(<AiSection now={now} />, { api: empty })
    expect(await screen.findByText('Nenhuma IA usou ainda.')).toBeInTheDocument()
    unmount()

    const many = new FakeApi()
    many.mcpActivity.mockResolvedValue(
      Array.from({ length: 60 }, (_, index) => ({
        at: new Date(NOW - index * 60_000).toISOString(),
        client: 'claude-code',
        tool: 'get_transcription',
        title: `Reunião ${index}`
      }))
    )
    await renderWithApp(<AiSection now={now} />, { api: many })
    const list = await screen.findByRole('list', { name: 'Atividade recente' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(50)
    expect(
      within(list).getByText(/Claude Code · leu uma transcrição “Reunião 0”/)
    ).toBeInTheDocument()
  })

  it('atividade sem título usa a linha simples', async () => {
    const api = new FakeApi()
    api.mcpActivity.mockResolvedValue([
      { at: new Date(NOW - 3_600_000).toISOString(), client: 'codex', tool: 'get_activity' }
    ])
    await renderWithApp(<AiSection now={now} />, { api })
    const list = await screen.findByRole('list', { name: 'Atividade recente' })
    expect(within(list).getByText('Codex · viu a atividade · há 1 h')).toBeInTheDocument()
  })

  it('é acessível nos temas claro e escuro', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const api = new FakeApi({ mcp: { enabled: true, allowTranscribe: true }, theme })
      api.mcpStatus.mockResolvedValue(
        statusWith([
          client({ id: 'codex', state: 'found' }),
          client({
            id: 'cursor',
            state: 'connected',
            lastUsedAt: new Date(NOW - 60_000).toISOString()
          })
        ])
      )
      const { container, unmount } = await renderWithApp(<AiSection now={now} />, { api })
      await screen.findByRole('heading', { name: 'Codex' })
      await expectAccessible(container)
      unmount()
    }
  })
})

describe('SettingsScreen — seção IAs (MCP)', () => {
  it('entra entre Ao vivo e Armazenamento e mostra a tela', async () => {
    const { user, store } = await renderWithApp(<SettingsScreen />)
    const nav = screen.getByRole('navigation', { name: 'Seções das configurações' })
    expect(within(nav).getByRole('button', { name: 'IAs (MCP)' })).toBeInTheDocument()
    await user.click(within(nav).getByRole('button', { name: 'IAs (MCP)' }))
    expect(store.getState().settingsSection).toBe('ai')
    expect(await screen.findByRole('heading', { name: 'Acesso de IAs' })).toBeInTheDocument()
  })
})
