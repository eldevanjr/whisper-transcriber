import { describe, expect, it } from 'vitest'
import {
  ActivitySnapshotSchema,
  BridgeRequestSchema,
  BridgeResponseSchema,
  JobProgressSchema,
  MCP_CLIENT_IDS,
  MCP_CLIENT_NAMES,
  McpActivityLineSchema,
  clientDisplayName
} from '../../src/shared/mcp'

const JOB_ID = '3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f'

describe('ids dos clientes MCP', () => {
  it('lista os oito clientes suportados, na ordem da tela', () => {
    expect(MCP_CLIENT_IDS).toEqual([
      'claude-code',
      'claude-desktop',
      'codex',
      'opencode',
      'cursor',
      'vscode',
      'gemini-cli',
      'windsurf'
    ])
  })
})

describe('nome de exibição dos clientes MCP', () => {
  it('mapeia cada id para o nome amigável, sem traduzir as marcas', () => {
    expect(MCP_CLIENT_NAMES).toEqual({
      'claude-code': 'Claude Code',
      'claude-desktop': 'Claude Desktop',
      codex: 'Codex',
      opencode: 'OpenCode',
      cursor: 'Cursor',
      vscode: 'VS Code',
      'gemini-cli': 'Gemini CLI',
      windsurf: 'Windsurf'
    })
    expect(clientDisplayName('claude-code')).toBe('Claude Code')
    expect(clientDisplayName('vscode')).toBe('VS Code')
  })

  it('id desconhecido volta como veio', () => {
    expect(clientDisplayName('minha-ia')).toBe('minha-ia')
  })
})

describe('requisições da ponte', () => {
  const valid = [
    { type: 'auth', rid: 1, token: 'segredo' },
    { type: 'ping', rid: 2 },
    { type: 'activity', rid: 3 },
    { type: 'status', rid: 4, id: JOB_ID },
    { type: 'transcribe', rid: 5, path: '/tmp/aula.mp4', client: 'claude-code' }
  ]

  it('aceita cada requisição válida', () => {
    for (const request of valid) {
      expect(BridgeRequestSchema.safeParse(request)).toMatchObject({ success: true })
    }
  })

  it('rejeita type desconhecido, path vazio e id que não é UUID', () => {
    expect(BridgeRequestSchema.safeParse({ type: 'nope', rid: 1 }).success).toBe(false)
    expect(
      BridgeRequestSchema.safeParse({ type: 'transcribe', rid: 6, path: '', client: 'x' }).success
    ).toBe(false)
    expect(
      BridgeRequestSchema.safeParse({ type: 'status', rid: 7, id: '../../etc/passwd' }).success
    ).toBe(false)
    expect(BridgeRequestSchema.safeParse({ type: 'status', rid: 8, id: 42 }).success).toBe(false)
  })
})

describe('respostas da ponte', () => {
  it('aceita ok com data e error com código conhecido', () => {
    expect(
      BridgeResponseSchema.safeParse({ type: 'ok', rid: 1, data: { appVersion: '1.0.0' } }).success
    ).toBe(true)
    expect(
      BridgeResponseSchema.safeParse({
        type: 'error',
        rid: 1,
        error: { code: 'MCP_DISABLED', message: 'desligado' }
      }).success
    ).toBe(true)
    expect(
      BridgeResponseSchema.safeParse({
        type: 'error',
        rid: 1,
        error: { code: 'CONFIG_INVALID', message: 'x', detail: 'd' }
      }).success
    ).toBe(true)
  })

  it('rejeita type desconhecido e código desconhecido', () => {
    expect(BridgeResponseSchema.safeParse({ type: 'nope', rid: 1 }).success).toBe(false)
    expect(
      BridgeResponseSchema.safeParse({
        type: 'error',
        rid: 1,
        error: { code: 'NOPE', message: 'x' }
      }).success
    ).toBe(false)
  })
})

describe('retrato de atividade', () => {
  it('valida o retrato completo com progresso, fila e ao vivo', () => {
    const snapshot = {
      appRunning: true,
      current: {
        id: JOB_ID,
        title: 'Reunião',
        phase: 'transcribing',
        pct: 42,
        processedS: 10,
        totalS: 60,
        speed: 2,
        etaS: 25,
        pass: { track: 'outros', index: 1, count: 2 },
        requestedBy: 'codex'
      },
      pending: [{ id: JOB_ID, title: 'Outra reunião' }],
      live: { id: JOB_ID, title: 'Ao vivo', startedAt: '2026-09-26T10:00:00.000Z' }
    }
    expect(ActivitySnapshotSchema.parse(snapshot)).toEqual(snapshot)
  })

  it('aceita retrato vazio e rejeita fase desconhecida', () => {
    expect(
      ActivitySnapshotSchema.safeParse({
        appRunning: false,
        current: null,
        pending: [],
        live: null
      }).success
    ).toBe(true)
    expect(
      JobProgressSchema.safeParse({
        id: JOB_ID,
        title: 'x',
        phase: 'nope',
        pct: 1,
        processedS: 1,
        totalS: 1,
        speed: 1,
        etaS: null
      }).success
    ).toBe(false)
  })
})

describe('linha de atividade', () => {
  it('valida linha com id/title e linha só com a ferramenta', () => {
    expect(
      McpActivityLineSchema.safeParse({
        at: '2026-09-26T10:00:00.000Z',
        client: 'claude-code',
        tool: 'get_transcription',
        id: JOB_ID,
        title: 'Reunião'
      }).success
    ).toBe(true)
    expect(
      McpActivityLineSchema.safeParse({
        at: '2026-09-26T10:00:00.000Z',
        client: 'codex',
        tool: 'list_transcriptions'
      }).success
    ).toBe(true)
  })
})
