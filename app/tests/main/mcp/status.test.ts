import { describe, expect, it } from 'vitest'
import { buildMcpStatus } from '../../../src/main/mcp/status'
import type { ClientStatus } from '../../../src/shared/mcp'

const CLIENTS: ClientStatus[] = [
  {
    id: 'codex',
    name: 'Codex',
    state: 'connected',
    lastUsedAt: null,
    restartNeeded: false,
    manual: { kind: 'toml', text: '[mcp_servers.whisper-transcriber]' }
  }
]

describe('buildMcpStatus', () => {
  it('lançador OK: motivo nulo', () => {
    expect(
      buildMcpStatus({
        launcher: { ok: true, error: null },
        launcherPath: '/lancador',
        bridgeOk: true,
        clients: CLIENTS
      })
    ).toEqual({
      launcherOk: true,
      launcherError: null,
      launcherPath: '/lancador',
      bridgeOk: true,
      clients: CLIENTS
    })
  })

  it('lançador com problema: carrega o motivo para a tela', () => {
    expect(
      buildMcpStatus({
        launcher: { ok: false, error: 'sem permissão de escrita' },
        launcherPath: '/lancador',
        bridgeOk: false,
        clients: []
      })
    ).toEqual({
      launcherOk: false,
      launcherError: 'sem permissão de escrita',
      launcherPath: '/lancador',
      bridgeOk: false,
      clients: []
    })
  })
})
