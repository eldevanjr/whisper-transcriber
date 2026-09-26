import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AppError, toAppError } from '../../shared/errors'
import type { McpTestResult } from '../../shared/ipc'

/** Limite do "Testar conexão" da tela de IAs (spec §10.2). */
export const MCP_SELF_TEST_TIMEOUT_MS = 20_000

export interface SelfTestTarget {
  command: string
  args: string[]
}

/** O que o teste precisa do cliente; o padrão é o cliente real do SDK por stdio. */
export interface SelfTestClient {
  connect(): Promise<void>
  listTools(): Promise<number>
  close(): Promise<void>
}

export type SelfTestClientFactory = (target: SelfTestTarget) => SelfTestClient

export interface SelfTestOptions {
  timeoutMs?: number
  /** Injetável nos testes; o padrão sobe o processo do lançador por stdio. */
  createClient?: SelfTestClientFactory
}

/** Cliente MCP do SDK falando com o processo do lançador por stdio (spec §6). */
export function createStdioSelfTestClient(target: SelfTestTarget): SelfTestClient {
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args,
    stderr: 'ignore'
  })
  const client = new Client({ name: 'whisper-transcriber-self-test', version: '1.0.0' })
  return {
    connect: () => client.connect(transport),
    listTools: async () => (await client.listTools()).tools.length,
    close: () => client.close()
  }
}

/**
 * Roda o lançador como um cliente MCP por stdio: `initialize` + `tools/list`, com 20 s de limite.
 * Sucesso devolve o número de ferramentas; qualquer falha vira erro do app.
 */
export async function runSelfTest(
  launcherPath: string,
  options: SelfTestOptions = {}
): Promise<McpTestResult> {
  const createClient = options.createClient ?? createStdioSelfTestClient
  const client = createClient({ command: launcherPath, args: [] })
  let timer: NodeJS.Timeout | undefined
  try {
    const tools = await Promise.race([
      handshake(client),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AppError('APP_START_TIMEOUT', 'Whisper Transcriber did not start in time.'))
        }, options.timeoutMs ?? MCP_SELF_TEST_TIMEOUT_MS)
      })
    ])
    return { ok: true, tools }
  } catch (error) {
    throw toAppError(error)
  } finally {
    clearTimeout(timer)
    await closeQuietly(client)
  }
}

async function handshake(client: SelfTestClient): Promise<number> {
  await client.connect()
  return client.listTools()
}

async function closeQuietly(client: SelfTestClient): Promise<void> {
  try {
    await client.close()
  } catch {
    // O processo do teste pode já ter morrido; isso não pode esconder o resultado.
  }
}
