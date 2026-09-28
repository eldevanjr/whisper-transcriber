import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { aiWorkerCommand, resolveWorkerCommand, workerEnv } from '../../src/main/worker/locate'
import { WorkerSupervisor } from '../../src/main/worker/supervisor'
import { makeTempDir } from '../helpers/tmp'

/** O processo da IA: o mesmo worker no modo "ai" (o app sobe um só para ela). */
const commandLine = aiWorkerCommand(
  resolveWorkerCommand({
    isPackaged: false,
    resourcesPath: '',
    appPath: join(__dirname, '..', '..'),
    platform: process.platform
  })
)

const SEGMENT = { index: 0, start: 0, end: 10, text: 'Sincronização offline com o servidor' }
/** Porta fechada de propósito: o worker deve cair para o SQLite (fallback). */
const CLOSED_PORT = 1

function supervisor(): WorkerSupervisor {
  return new WorkerSupervisor({
    spawn: (command, args, options) => spawn(command, [...args], { ...options, stdio: 'pipe' }),
    commandLine,
    envFor: (device) =>
      workerEnv(process.env, { platform: process.platform, device, cudaDir: '/nao-existe' }),
    expectedVersion: pkg.version,
    logger: console
  })
}

type Reply = (path: string) => { status?: number; body: unknown; delayMs?: number }

/** Servidor que finge ser o Ollama: /api/tags (só GET, como o real), /api/generate e /api/embeddings. */
async function fakeOllama(reply?: Reply): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk) => (raw += String(chunk)))
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? ''
      const wrongMethod = path === '/api/tags' && request.method !== 'GET'
      const answer = wrongMethod
        ? { status: 405, body: { error: 'method not allowed' } }
        : (reply?.(path) ?? defaultReply(path))
      const send = (): void => {
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.body))
      }
      if (answer.delayMs !== undefined && answer.delayMs > 0) setTimeout(send, answer.delayMs)
      else send()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      })
  }
}

function defaultReply(path: string): { status?: number; body: unknown; delayMs?: number } {
  if (path === '/api/tags') {
    return { body: { models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text:latest' }] } }
  }
  if (path === '/api/embeddings') return { body: { embedding: [1, 0, 0] } }
  return {
    body: {
      response:
        '{"topics":[{"name":"Sincronização","source_segments":[0]}],"tasks":[{"description":"Corrigir"}]}'
    }
  }
}

async function configure(
  worker: WorkerSupervisor,
  ollamaUrl: string,
  database: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await worker.request({
    cmd: 'configure_ai',
    params: {
      enabled: true,
      ollama_url: ollamaUrl,
      llm_model: 'qwen3:8b',
      embedding_model: 'nomic-embed-text',
      incremental_analysis_enabled: true,
      final_analysis_enabled: true,
      analysis_window_seconds: 45,
      analysis_overlap_seconds: 10,
      max_concurrent_analysis: 1,
      prompt_version: '1',
      request_timeout_seconds: 120,
      allow_remote_ollama: false,
      database_path: database,
      storage: {
        mode: 'external',
        postgres: {
          host: '127.0.0.1',
          port: CLOSED_PORT,
          database: 'whisper',
          username: 'whisper',
          password: 'x',
          ssl_mode: 'prefer',
          connect_timeout: 1
        }
      },
      ...overrides
    }
  })
}

interface StatusReply {
  status: {
    configured: boolean
    enabled: boolean
    analysis: Record<string, number>
    index: Record<string, number>
    storage: { kind: string; fallback: boolean }
  }
}
interface AnalysisReply {
  analysis: { result: { topics: { name: string; source_segments: { start: number }[] }[] } } | null
}
interface SearchReply {
  results: { chunk: { document_id: string; content: string } }[]
}
interface AskReply {
  answer: string
  sources: { chunk: { document_id: string } }[]
}
interface DiagnosticsReply {
  diagnostics: { checks: { name: string; ok: boolean }[] }
}

async function status(worker: WorkerSupervisor): Promise<StatusReply['status']> {
  return ((await worker.request({ cmd: 'ai_status' })) as unknown as StatusReply).status
}

async function analysisOf(worker: WorkerSupervisor, id = 't1'): Promise<AnalysisReply['analysis']> {
  const reply = (await worker.request({
    cmd: 'analysis_get',
    params: { workspace_id: 'ws', transcription_id: id }
  })) as unknown as AnalysisReply
  return reply.analysis
}

const pending = (counts: Record<string, number>): number =>
  (counts.PENDING ?? 0) + (counts.PROCESSING ?? 0)

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condição não ocorreu a tempo')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function submit(worker: WorkerSupervisor, id = 't1'): Promise<void> {
  await worker.request({
    cmd: 'analysis_submit',
    params: { transcription_id: id, workspace_id: 'ws', title: 'Reunião', segments: [SEGMENT] }
  })
}

/** O worker processa sozinho (em segundo plano): espera a análise final e o índice. */
async function submitAndWait(worker: WorkerSupervisor, id = 't1'): Promise<void> {
  await submit(worker, id)
  await waitFor(async () => {
    const current = await status(worker)
    return pending(current.analysis) === 0 && pending(current.index) === 0
  })
  await waitFor(async () => (await analysisOf(worker, id)) !== null)
}

describe('IA local (worker real no modo "ai" + Ollama simulado)', () => {
  it('analisa, indexa, busca e responde com fontes; cai para SQLite sem PostgreSQL', async () => {
    const ollama = await fakeOllama()
    const worker = supervisor()
    const database = join(await makeTempDir(), 'ai.sqlite')
    try {
      await configure(worker, ollama.url, database)
      expect(await status(worker)).toMatchObject({
        configured: true,
        enabled: true,
        storage: { kind: 'sqlite', fallback: true }
      })

      await submitAndWait(worker)
      const topic = (await analysisOf(worker))?.result.topics[0]
      expect(topic?.name).toBe('Sincronização')
      expect(topic?.source_segments[0]?.start).toBe(0)

      const search = (await worker.request({
        cmd: 'knowledge_search',
        params: { workspace_id: 'ws', query: 'sincronização', limit: 5 }
      })) as unknown as SearchReply
      expect(search.results).toHaveLength(1)
      const documentId = search.results[0]!.chunk.document_id
      expect(search.results[0]!.chunk.content).toContain('Sincronização')

      const answer = (await worker.request({
        cmd: 'knowledge_ask',
        params: { workspace_id: 'ws', question: 'o que foi decidido?', limit: 5 }
      })) as unknown as AskReply
      expect(answer.answer).not.toBe('')
      expect(answer.sources[0]!.chunk.document_id).toBe(documentId)
    } finally {
      worker.dispose()
      await ollama.close()
    }
  })

  it('Ollama lento segura só a análise: o worker da IA segue respondendo', async () => {
    const ollama = await fakeOllama((path) =>
      path === '/api/generate'
        ? { body: { response: '{"topics":[]}' }, delayMs: 8000 }
        : defaultReply(path)
    )
    const worker = supervisor()
    const database = join(await makeTempDir(), 'ai.sqlite')
    try {
      await configure(worker, ollama.url, database)
      const started = Date.now()
      await submit(worker)
      expect(Date.now() - started).toBeLessThan(3000)
      // Enquanto a geração está presa, indexação, busca e status andam.
      await waitFor(async () => pending((await status(worker)).index) === 0, 5000)
      const search = (await worker.request({
        cmd: 'knowledge_search',
        params: { workspace_id: 'ws', query: 'sincronização', limit: 5 }
      })) as unknown as SearchReply
      expect(search.results).toHaveLength(1)
      expect(pending((await status(worker)).analysis)).toBeGreaterThan(0)
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      worker.dispose()
      await ollama.close()
    }
  })

  it('faz backup e restaura conhecimento e análises', async () => {
    const ollama = await fakeOllama()
    const worker = supervisor()
    const dir = await makeTempDir()
    const database = join(dir, 'ai.sqlite')
    const path = join(dir, 'backup.json')
    try {
      await configure(worker, ollama.url, database)
      await submitAndWait(worker)

      const backup = (await worker.request({
        cmd: 'knowledge_backup',
        params: { workspace_id: 'ws', path }
      })) as { documents: number; chunks: number; analyses: number }
      expect(backup.analyses).toBe(1)
      expect(backup.documents).toBeGreaterThan(0)

      await worker.request({
        cmd: 'knowledge_delete',
        params: { workspace_id: 'ws', transcription_id: 't1' }
      })
      expect(await analysisOf(worker)).toBeNull()

      const restored = (await worker.request({
        cmd: 'knowledge_restore',
        params: { path, workspace_id: 'ws' }
      })) as { documents: number; chunks: number; analyses: number }
      expect(restored.analyses).toBe(1)
      expect(restored.documents).toBe(backup.documents)
      expect((await analysisOf(worker))?.result.topics[0]?.name).toBe('Sincronização')
    } finally {
      worker.dispose()
      await ollama.close()
    }
  })

  it('Ollama fora do ar: nada trava e as janelas esperam na fila (sem gastar tentativas)', async () => {
    const worker = supervisor()
    const database = join(await makeTempDir(), 'ai.sqlite')
    try {
      await configure(worker, `http://127.0.0.1:${CLOSED_PORT}`, database)
      await submit(worker)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const current = await status(worker)
      expect(current.analysis.PENDING).toBe(1)
      expect(current.analysis.FAILED ?? 0).toBe(0)
      expect(await analysisOf(worker)).toBeNull()
    } finally {
      worker.dispose()
    }
  })

  it('a fila sobrevive ao worker reiniciar e termina quando o Ollama volta', async () => {
    const dir = await makeTempDir()
    const database = join(dir, 'ai.sqlite')
    const first = supervisor()
    try {
      await configure(first, `http://127.0.0.1:${CLOSED_PORT}`, database)
      await submit(first)
    } finally {
      first.dispose()
    }
    const ollama = await fakeOllama()
    const second = supervisor()
    try {
      await configure(second, ollama.url, database)
      await waitFor(async () => (await analysisOf(second)) !== null)
      expect((await analysisOf(second))?.result.topics[0]?.name).toBe('Sincronização')
    } finally {
      second.dispose()
      await ollama.close()
    }
  })

  it('resposta JSON inválida esgota as tentativas sem derrubar o worker', async () => {
    const ollama = await fakeOllama((path) =>
      path === '/api/generate' ? { body: { response: 'não é json' } } : defaultReply(path)
    )
    const worker = supervisor()
    const database = join(await makeTempDir(), 'ai.sqlite')
    try {
      await configure(worker, ollama.url, database)
      await submit(worker)
      await waitFor(async () => ((await status(worker)).analysis.FAILED ?? 0) === 1)
      expect(await status(worker)).toMatchObject({ enabled: true })
    } finally {
      worker.dispose()
      await ollama.close()
    }
  })

  it('diagnóstico aponta o Ollama (GET /api/tags, modelo :latest) e o banco em uso', async () => {
    const ollama = await fakeOllama()
    const worker = supervisor()
    const database = join(await makeTempDir(), 'ai.sqlite')
    try {
      await configure(worker, ollama.url, database)
      const result = (await worker.request({ cmd: 'ai_diagnose' })) as unknown as DiagnosticsReply
      const checks = Object.fromEntries(
        result.diagnostics.checks.map((check) => [check.name, check.ok])
      )
      expect(checks).toMatchObject({ ollama: true, llm: true, embeddings: true, rag: true })
      expect(checks.postgres).toBe(false)
    } finally {
      worker.dispose()
      await ollama.close()
    }
  })
})
