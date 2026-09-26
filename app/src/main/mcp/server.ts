import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError, type Resource } from '@modelcontextprotocol/sdk/types.js'
import type { ActivitySnapshot, JobProgress } from '../../shared/mcp'
import type { JobStatus } from '../../shared/history'
import type { Settings } from '../../shared/settings'
import type { ActivityLog } from './activity'
import type { ListedTranscription, TranscriptLibrary } from './library'
import { registerPrompts } from './prompts'
import { MCP_DISABLED_MESSAGE, registerReadTools, type McpContext } from './tools-read'

/** Resultado de um pedido de transcrição pela ponte (spec §9.8); a ponte real é a Task 7. */
export interface TranscribeOutcome {
  id: string
  status: JobStatus
  position?: number
}

/**
 * Ponte app ↔ processo MCP (spec §7): o app aberto responde atividade, status e transcrever.
 * A Task 4 só define o contrato; a implementação real (e as ferramentas de atividade) é a Task 7.
 */
export interface BridgePort {
  activity(): Promise<ActivitySnapshot>
  status(id: string): Promise<JobProgress | null>
  transcribe(
    path: string,
    client: string,
    wait: boolean,
    onProgress?: (progress: JobProgress) => void
  ): Promise<TranscribeOutcome>
}

export interface McpServerDeps {
  library: TranscriptLibrary
  activity: ActivityLog
  readSettings: () => Promise<Settings>
  bridge: BridgePort
  version: string
}

/** Nome do servidor registrado nas configs dos clientes (Global Constraints). */
export const MCP_SERVER_NAME = 'whisper-transcriber'

/** Monta o servidor MCP com as ferramentas de leitura, os prompts e os recursos (spec §9). */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const { library, activity, readSettings, version } = deps
  const server = new McpServer({ name: MCP_SERVER_NAME, version })
  const context: McpContext = {
    library,
    activity,
    readSettings,
    clientName: () => clientNameOf(server)
  }
  registerReadTools(server, context)
  registerPrompts(server, context)
  registerResources(server, context)
  return server
}

/** `clientInfo.name` do handshake (spec §5.2); antes de inicializar não há cliente. */
export function clientNameOf(server: McpServer): string {
  return server.server.getClientVersion()?.name ?? 'unknown'
}

/** `resources/list` + `resources/read` sobre `transcription://<id>` (spec §9.10). */
function registerResources(server: McpServer, context: McpContext): void {
  const template = new ResourceTemplate('transcription://{id}', {
    list: async () => {
      const settings = await context.readSettings()
      if (!settings.mcp.enabled) return { resources: [] }
      const { items } = await context.library.list({ status: 'done', limit: 20 })
      return { resources: items.map(toResource) }
    }
  })
  server.registerResource(
    'transcription',
    template,
    { mimeType: 'text/plain' },
    async (uri, variables) => {
      const settings = await context.readSettings()
      if (!settings.mcp.enabled) throw new McpError(ErrorCode.InvalidRequest, MCP_DISABLED_MESSAGE)
      const page = await context.library.read(String(variables.id), { format: 'text' })
      return {
        contents: [{ uri: uri.toString(), mimeType: 'text/plain', text: page.content }]
      }
    }
  )
}

function toResource(item: ListedTranscription): Resource {
  return { uri: `transcription://${item.id}`, name: item.title, mimeType: 'text/plain' }
}
