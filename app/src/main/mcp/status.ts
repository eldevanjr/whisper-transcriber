import type { McpStatus } from '../../shared/ipc'
import type { ClientStatus } from '../../shared/mcp'
import type { LauncherStatus } from './launcher'

export interface McpStatusInput {
  launcher: LauncherStatus
  launcherPath: string
  bridgeOk: boolean
  clients: ClientStatus[]
}

/**
 * Retrato da seção de IAs (spec §10.2): o motivo entra quando o lançador não foi gravado, para a
 * tela mostrar "Com problema: <motivo>"; com o lançador OK, o motivo é nulo.
 */
export function buildMcpStatus(input: McpStatusInput): McpStatus {
  return {
    launcherOk: input.launcher.ok,
    launcherError: input.launcher.error,
    launcherPath: input.launcherPath,
    bridgeOk: input.bridgeOk,
    clients: input.clients
  }
}
