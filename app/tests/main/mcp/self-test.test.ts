import { chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStdioSelfTestClient,
  MCP_SELF_TEST_TIMEOUT_MS,
  runSelfTest,
  type SelfTestClient
} from '../../../src/main/mcp/self-test'
import { makeTempDir } from '../../helpers/tmp'

/** Servidor MCP mínimo no protocolo JSON-RPC por stdio (uma mensagem por linha). */
const OK_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, index)
    buf = buf.slice(index + 1)
    if (line.trim() !== '') handle(JSON.parse(line))
  }
})
function tool(name) {
  return { name, description: '', inputSchema: { type: 'object' } }
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' }
      }
    })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('a'), tool('b')] } })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
}
`

const GARBAGE_SERVER = `
process.stdout.write('isto não é JSON-RPC\\n', () => process.exit(1))
`

const SILENT_SERVER = `process.stdin.resume()\n`

let root: string

beforeEach(async () => {
  root = await makeTempDir()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeScript(name: string, body: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, body, 'utf8')
  await chmod(path, 0o755)
  return path
}

/** Usa o cliente real do SDK, mas troca o comando do processo pela fixture Node. */
function viaNode(script: string): (target: { command: string; args: string[] }) => SelfTestClient {
  return (target) => createStdioSelfTestClient({ command: target.command, args: [script] })
}

function fakeClient(overrides: Partial<SelfTestClient> = {}): SelfTestClient {
  return {
    connect: vi.fn(() => Promise.resolve()),
    listTools: vi.fn(() => Promise.resolve(8)),
    close: vi.fn(() => Promise.resolve()),
    ...overrides
  }
}

describe('runSelfTest', () => {
  it('roda o lançador como cliente MCP e conta as ferramentas', async () => {
    const script = await writeScript('ok.mjs', OK_SERVER)
    await expect(runSelfTest(process.execPath, { createClient: viaNode(script) })).resolves.toEqual(
      { ok: true, tools: 2 }
    )
  })

  it('lixo no stdout do processo vira erro', async () => {
    const script = await writeScript('garbage.mjs', GARBAGE_SERVER)
    await expect(
      runSelfTest(process.execPath, { createClient: viaNode(script), timeoutMs: 2000 })
    ).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('estoura o limite de tempo e devolve APP_START_TIMEOUT', async () => {
    const script = await writeScript('silent.mjs', SILENT_SERVER)
    await expect(
      runSelfTest(process.execPath, { createClient: viaNode(script), timeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'APP_START_TIMEOUT' })
  })

  it('erro do SDK vira INTERNAL e fecha o cliente', async () => {
    const close = vi.fn(() => Promise.resolve())
    const client = fakeClient({
      connect: vi.fn(() => Promise.reject(new Error('não subiu'))),
      close
    })
    await expect(runSelfTest('/qualquer', { createClient: () => client })).rejects.toMatchObject({
      code: 'INTERNAL'
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('falha ao fechar não esconde o resultado', async () => {
    const close = vi.fn(() => Promise.reject(new Error('já morreu')))
    const client = fakeClient({ close })
    await expect(runSelfTest('/qualquer', { createClient: () => client })).resolves.toEqual({
      ok: true,
      tools: 8
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('sem injeção, usa o cliente real e falha se o lançador não existir', async () => {
    await expect(runSelfTest(join(root, 'nao-existe'), { timeoutMs: 500 })).rejects.toMatchObject({
      code: 'INTERNAL'
    })
  })

  it('o limite padrão é de 20 s', () => {
    expect(MCP_SELF_TEST_TIMEOUT_MS).toBe(20_000)
  })
})
