import { describe, expect, it, vi } from 'vitest'
import {
  AiSession,
  DEFAULT_CONTAINER_VOLUME,
  MAX_WORKER_LINE_BYTES,
  toConfigureParams,
  type AiSecrets,
  type AiSessionDeps
} from '../../../src/main/ai/session'
import type { WorkerCommand } from '../../../src/main/worker/protocol'
import type { WorkerPort } from '../../../src/main/worker/supervisor'
import type { AiReindexProgress } from '../../../src/shared/events'
import { AppError } from '../../../src/shared/errors'
import type { AiSecretKind } from '../../../src/shared/ipc'
import { DEFAULT_SETTINGS, type AiSettings, type Settings } from '../../../src/shared/settings'

type Responder = (command: WorkerCommand) => unknown

function makeWorker(responses: Record<string, unknown> = {}): {
  port: WorkerPort
  calls: WorkerCommand[]
} {
  const calls: WorkerCommand[] = []
  const port: WorkerPort = {
    request: vi.fn((command: WorkerCommand) => {
      calls.push(command)
      const response = responses[command.cmd]
      try {
        const value = typeof response === 'function' ? (response as Responder)(command) : response
        return Promise.resolve((value as Record<string, unknown> | undefined) ?? {})
      } catch (error) {
        return Promise.reject(error)
      }
    }),
    kill: vi.fn()
  }
  return { port, calls }
}

function settingsWith(
  enabled: boolean,
  workspaceId = 'default',
  ai: Partial<AiSettings> = {}
): { get(): Settings } {
  return {
    get: () => ({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, enabled, workspaceId, ...ai }
    })
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

class MemorySecrets implements AiSecrets {
  readonly values = new Map<AiSecretKind, string>()
  constructor(private readonly vault = true) {}
  get(kind: AiSecretKind): string | null {
    return this.values.get(kind) ?? null
  }
  available(): boolean {
    return this.vault
  }
  set(kind: AiSecretKind, value: string): Promise<unknown> {
    this.values.set(kind, value)
    return Promise.resolve()
  }
}

const segment = { index: 0, start: 0, end: 1, text: 'x' }

function session(worker: WorkerPort, overrides: Partial<AiSessionDeps> = {}): AiSession {
  return new AiSession({
    worker,
    settings: settingsWith(true),
    secrets: new MemorySecrets(),
    databasePath: '/db',
    logger,
    hasData: () => false,
    sleep: () => Promise.resolve(),
    ...overrides
  })
}

const configures = (calls: WorkerCommand[]): number =>
  calls.filter((command) => command.cmd === 'configure_ai').length

describe('AiSession — configuração', () => {
  it('configure não repete enquanto nada muda; reset força de novo', async () => {
    const { port, calls } = makeWorker()
    const ai = session(port)
    await ai.configure()
    await ai.configure()
    expect(configures(calls)).toBe(1)
    ai.reset()
    await ai.configure()
    expect(configures(calls)).toBe(2)
  })

  it('trocar a senha do banco reconfigura o worker', async () => {
    const { port, calls } = makeWorker()
    const secrets = new MemorySecrets()
    const ai = session(port, { secrets })
    await ai.configure()
    secrets.values.set('postgres', 'nova')
    await ai.configure()
    expect(configures(calls)).toBe(2)
  })

  it('modo local/automático gera a senha do container uma vez e a guarda no cofre', async () => {
    const { port, calls } = makeWorker()
    const secrets = new MemorySecrets()
    const settings = settingsWith(true, 'default', {
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'auto' }
    })
    const ai = session(port, { secrets, settings, randomSecret: () => 'gerada' })
    await ai.configure()
    expect(secrets.get('container')).toBe('gerada')
    const params = (calls[0] as Extract<WorkerCommand, { cmd: 'configure_ai' }>).params
    expect(params.storage.password).toBe('gerada')
    expect(params.storage.volume).toBe(DEFAULT_CONTAINER_VOLUME)
  })

  it('a senha gerada por padrão é aleatória e longa', async () => {
    const secrets = new MemorySecrets()
    const settings = settingsWith(true, 'default', {
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'local' }
    })
    await session(makeWorker().port, { secrets, settings }).configure()
    expect(secrets.get('container')?.length).toBeGreaterThanOrEqual(24)
  })

  it('senha do container já guardada não é trocada', async () => {
    const secrets = new MemorySecrets()
    secrets.values.set('container', 'antiga')
    const settings = settingsWith(true, 'default', {
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'auto' }
    })
    await session(makeWorker().port, { secrets, settings, randomSecret: () => 'nova' }).configure()
    expect(secrets.get('container')).toBe('antiga')
  })

  it('sem hasData nem sleep injetados usa os padrões', async () => {
    const { port, calls } = makeWorker()
    const ai = new AiSession({
      worker: port,
      settings: settingsWith(false),
      secrets: new MemorySecrets(),
      databasePath: '/db',
      logger
    })
    expect(await ai.getAnalysis('t')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('sem cofre do sistema, não inventa senha (mudaria a cada abertura)', async () => {
    const { port } = makeWorker()
    const secrets = new MemorySecrets(false)
    const settings = settingsWith(true, 'default', {
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'local' }
    })
    await session(port, { secrets, settings, randomSecret: () => 'x' }).configure()
    expect(secrets.get('container')).toBeNull()
  })

  it('worker reiniciado (AI_NOT_CONFIGURED): reconfigura e repete o comando uma vez', async () => {
    let failures = 1
    const { port, calls } = makeWorker({
      ai_diagnose: () => {
        if (failures-- > 0) throw new AppError('AI_NOT_CONFIGURED', 'IA não configurada')
        return { diagnostics: { checks: [] } }
      }
    })
    const ai = session(port)
    expect(await ai.diagnose()).toEqual({ checks: [] })
    expect(configures(calls)).toBe(2)
  })

  it('outros erros (e a segunda falha) chegam a quem chamou', async () => {
    const always = makeWorker({
      ai_diagnose: () => {
        throw new AppError('AI_NOT_CONFIGURED', 'IA não configurada')
      }
    })
    await expect(session(always.port).diagnose()).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED'
    })
    const other = makeWorker({
      ai_diagnose: () => {
        throw new AppError('AI_DISABLED', 'desligada')
      }
    })
    await expect(session(other.port).diagnose()).rejects.toMatchObject({ code: 'AI_DISABLED' })
    expect(configures(other.calls)).toBe(1)
  })
})

describe('AiSession — análise', () => {
  it('submit ignora IA desligada e transcrição sem fala', async () => {
    const { port, calls } = makeWorker()
    await session(port, { settings: settingsWith(false) }).submit({
      transcriptionId: 't',
      title: 'T',
      segments: [segment]
    })
    await session(port).submit({ transcriptionId: 't', title: 'T', segments: [] })
    expect(calls).toHaveLength(0)
  })

  it('submit envia a transcrição sem processar na hora (o worker processa sozinho)', async () => {
    const { port, calls } = makeWorker()
    await session(port).submit({ transcriptionId: 't', title: 'T', segments: [segment] })
    expect(calls.map((command) => command.cmd)).toEqual(['configure_ai', 'analysis_submit'])
    expect(calls[1]).toMatchObject({ params: { workspace_id: 'default', title: 'T' } })
  })

  it('transcrição longa vai em lotes que cabem no limite de linha do worker', async () => {
    const { port, calls } = makeWorker()
    const long = Array.from({ length: 3000 }, (_, index) => ({
      index,
      start: index * 1.4,
      end: index * 1.4 + 1.4,
      text: `trecho ${String(index)} com algumas palavras faladas na reunião`
    }))
    await session(port).submit({ transcriptionId: 't', title: 'T', segments: long })
    const sent = calls.filter((command) => command.cmd !== 'configure_ai')
    expect(sent.length).toBeGreaterThan(2)
    expect(sent.at(-1)?.cmd).toBe('analysis_submit')
    expect(sent.slice(0, -1).every((command) => command.cmd === 'analysis_append')).toBe(true)
    for (const command of sent) {
      expect(JSON.stringify(command).length).toBeLessThan(MAX_WORKER_LINE_BYTES)
    }
    const total = sent.flatMap((command) =>
      'params' in command && command.params && 'segments' in command.params
        ? command.params.segments
        : []
    )
    expect(total).toHaveLength(3000)
  })

  it('append longo também é dividido', async () => {
    const { port, calls } = makeWorker()
    const long = Array.from({ length: 2000 }, (_, index) => ({
      index,
      start: index,
      end: index + 1,
      text: 'fala '.repeat(10)
    }))
    await session(port).append({ transcriptionId: 't', title: 'T', segments: long })
    const appends = calls.filter((command) => command.cmd === 'analysis_append')
    expect(appends.length).toBeGreaterThan(1)
  })

  it('submit e append aceitam workspace explícito', async () => {
    const { port, calls } = makeWorker()
    const ai = session(port)
    await ai.submit({ transcriptionId: 't', title: 'T', segments: [segment], workspaceId: 'ws' })
    await ai.append({ transcriptionId: 't', title: 'T', segments: [segment], workspaceId: 'ws' })
    expect(calls[1]).toMatchObject({ cmd: 'analysis_submit', params: { workspace_id: 'ws' } })
    expect(calls[2]).toMatchObject({ cmd: 'analysis_append', params: { workspace_id: 'ws' } })
  })

  it('append ignora IA desligada e lote vazio', async () => {
    const { port, calls } = makeWorker()
    await session(port, { settings: settingsWith(false) }).append({
      transcriptionId: 't',
      title: 'T',
      segments: [segment]
    })
    await session(port).append({ transcriptionId: 't', title: 'T', segments: [] })
    expect(calls).toHaveLength(0)
  })

  it('retry devolve quantas janelas voltaram à fila', async () => {
    const { port, calls } = makeWorker({ analysis_retry: { retried: 2 } })
    expect(await session(port).retry('t')).toBe(2)
    expect(calls[1]).toEqual({ cmd: 'analysis_retry', params: { transcription_id: 't' } })
    const empty = makeWorker({ analysis_retry: {} })
    expect(await session(empty.port).retry()).toBe(0)
    expect(empty.calls[1]).toEqual({ cmd: 'analysis_retry', params: {} })
  })

  it('forget apaga o conhecimento derivado mesmo com a IA desligada, se houver dados', async () => {
    const off = makeWorker()
    await session(off.port, { settings: settingsWith(false) }).forget('t')
    expect(off.calls).toHaveLength(0)
    const withData = makeWorker()
    await session(withData.port, { settings: settingsWith(false), hasData: () => true }).forget('t')
    expect(withData.calls[1]).toEqual({
      cmd: 'knowledge_delete',
      params: { workspace_id: 'default', transcription_id: 't' }
    })
  })
})

describe('AiSession — leitura', () => {
  it('IA desligada e sem dados: nada sobe o worker da IA', async () => {
    const { port, calls } = makeWorker()
    const ai = session(port, { settings: settingsWith(false) })
    expect(await ai.getAnalysis('t')).toBeNull()
    expect(await ai.searchEntities('topic')).toEqual([])
    expect(await ai.searchKnowledge('q')).toEqual([])
    expect(await ai.status()).toEqual({ configured: false, enabled: false })
    expect(calls).toHaveLength(0)
  })

  it('searchKnowledge retorna array e tolera resposta inválida', async () => {
    expect(
      await session(makeWorker({ knowledge_search: { results: [1, 2] } }).port).searchKnowledge('q')
    ).toEqual([1, 2])
    expect(
      await session(makeWorker({ knowledge_search: { results: 'nope' } }).port).searchKnowledge('q')
    ).toEqual([])
  })

  it('ask devolve resposta, modelo e fontes normalizados', async () => {
    const good = makeWorker({ knowledge_ask: { answer: 'ok', model: 'm', sources: [1] } })
    expect(await session(good.port).ask('q')).toEqual({ answer: 'ok', model: 'm', sources: [1] })
    const bad = makeWorker({ knowledge_ask: { answer: 5, model: 7, sources: 'x' } })
    expect(await session(bad.port).ask('q')).toEqual({ answer: '', model: null, sources: [] })
  })

  it('searchEntities envia kind e query opcional', async () => {
    const { port, calls } = makeWorker({ knowledge_search_entities: { entities: [{ id: 1 }] } })
    const ai = session(port)
    expect(await ai.searchEntities('topic', 'sync')).toEqual([{ id: 1 }])
    await ai.searchEntities('task')
    expect(calls[calls.length - 1]).toEqual({
      cmd: 'knowledge_search_entities',
      params: { workspace_id: 'default', kind: 'task', limit: 20 }
    })
  })

  it('getAnalysis devolve a análise ou null', async () => {
    const found = makeWorker({ analysis_get: { analysis: { id: 'a' } } })
    expect(await session(found.port).getAnalysis('t')).toEqual({ id: 'a' })
    expect(await session(makeWorker().port).getAnalysis('t')).toBeNull()
  })

  it('status configura e pede o estado do workspace', async () => {
    const { port, calls } = makeWorker({ ai_status: { status: { configured: true } } })
    expect(await session(port).status()).toEqual({ configured: true })
    expect(calls[1]).toEqual({ cmd: 'ai_status', params: { workspace_id: 'default' } })
    expect(await session(makeWorker({ ai_status: { status: 5 } }).port).status()).toEqual({})
  })

  it('diagnose configura e pede o diagnóstico', async () => {
    const { port } = makeWorker({
      ai_diagnose: { diagnostics: { checks: [{ name: 'ollama', ok: true }] } }
    })
    expect(await session(port).diagnose()).toEqual({ checks: [{ name: 'ollama', ok: true }] })
  })
})

describe('AiSession — reindexação', () => {
  function indexStatus(pending: number, completed: number): { status: Record<string, unknown> } {
    return { status: { index: { PENDING: pending, COMPLETED: completed } } }
  }

  it('acompanha o progresso até a fila esvaziar', async () => {
    const statuses = [indexStatus(2, 0), indexStatus(1, 1), indexStatus(0, 2)]
    const { port, calls } = makeWorker({
      knowledge_reindex: { enqueued: 2 },
      ai_status: () => statuses.shift() ?? indexStatus(0, 2)
    })
    const progress: AiReindexProgress[] = []
    expect(await session(port).reindex(undefined, (p) => progress.push(p))).toBe(2)
    expect(progress).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
      { completed: 2, total: 2 }
    ])
    expect(calls.some((command) => command.cmd === 'analysis_process')).toBe(false)
  })

  it('ignora contagens inválidas no progresso', async () => {
    const { port } = makeWorker({
      knowledge_reindex: { enqueued: 1 },
      ai_status: { status: { index: { COMPLETED: 1, RUIM: 'x' } } }
    })
    const progress: AiReindexProgress[] = []
    await session(port).reindex(undefined, (p) => progress.push(p))
    expect(progress).toEqual([{ completed: 1, total: 1 }])
  })

  it('sem resposta do worker, conta 0 e termina', async () => {
    const { port } = makeWorker({ knowledge_reindex: {}, ai_status: { status: {} } })
    expect(await session(port).reindex('outro')).toBe(0)
  })

  it('cancelar tira da fila o que ainda não foi indexado', async () => {
    const { port, calls } = makeWorker({
      knowledge_reindex: { enqueued: 5 },
      ai_status: indexStatus(5, 0)
    })
    const ai = session(port, {
      sleep: () => {
        ai.cancelReindex()
        return Promise.resolve()
      }
    })
    expect(await ai.reindex()).toBe(5)
    expect(calls[calls.length - 1]).toEqual({
      cmd: 'knowledge_reindex_cancel',
      params: { workspace_id: 'default' }
    })
  })
})

describe('toConfigureParams', () => {
  const none: AiSecrets = { get: () => null, available: () => false, set: () => Promise.resolve() }

  it('traduz camelCase para snake_case', () => {
    const params = toConfigureParams(DEFAULT_SETTINGS.ai, '/db/ai.sqlite', none)
    expect(params.ollama_url).toBe('http://localhost:11434')
    expect(params.analysis_window_seconds).toBe(45)
    expect(params.database_path).toBe('/db/ai.sqlite')
    expect(params.storage.mode).toBe('fallback')
    expect(params.allow_remote_ollama).toBe(false)
  })

  it('injeta as senhas do cofre no armazenamento', () => {
    const external = {
      ...DEFAULT_SETTINGS.ai,
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'external' as const }
    }
    const params = toConfigureParams(external, '/db', {
      ...none,
      get: (kind) => (kind === 'postgres' ? 'segredo' : null)
    })
    expect(params.storage.postgres?.password).toBe('segredo')

    const local = {
      ...DEFAULT_SETTINGS.ai,
      storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'local' as const, volume: '/tmp/pg' }
    }
    const localParams = toConfigureParams(local, '/db', {
      ...none,
      get: (kind) => (kind === 'container' ? 'senha' : null)
    })
    expect(localParams.storage.password).toBe('senha')
    expect(localParams.storage.volume).toBe('/tmp/pg')
  })

  it('volume vazio: padrão no modo local; ausente no fallback', () => {
    const local = toConfigureParams(
      { ...DEFAULT_SETTINGS.ai, storage: { ...DEFAULT_SETTINGS.ai.storage, mode: 'local' } },
      '/db',
      none
    )
    expect(local.storage.volume).toBe(DEFAULT_CONTAINER_VOLUME)
    expect(local.storage.password).toBeUndefined()
    expect(toConfigureParams(DEFAULT_SETTINGS.ai, '/db', none).storage.volume).toBeUndefined()
  })
})

describe('AiSession — backup/restore', () => {
  it('traduz os totais e usa o workspace das settings', async () => {
    const { port, calls } = makeWorker({
      knowledge_backup: { documents: 2, chunks: 5, analyses: 1 },
      knowledge_restore: { documents: 3, chunks: 7, analyses: 2 }
    })
    const ai = session(port, { settings: settingsWith(true, 'trabalho') })
    expect(await ai.backup('/tmp/b.json')).toEqual({ documents: 2, chunks: 5, analyses: 1 })
    expect(await ai.restore('/tmp/b.json')).toEqual({ documents: 3, chunks: 7, analyses: 2 })
    expect(calls.find((command) => command.cmd === 'knowledge_backup')).toMatchObject({
      params: { workspace_id: 'trabalho', path: '/tmp/b.json' }
    })
    expect(calls.find((command) => command.cmd === 'knowledge_restore')).toMatchObject({
      params: { path: '/tmp/b.json', workspace_id: 'trabalho' }
    })
  })

  it('campos ausentes viram zero', async () => {
    const { port } = makeWorker({ knowledge_backup: {}, knowledge_restore: { documents: 'x' } })
    const ai = session(port)
    expect(await ai.backup('/tmp/b.json')).toEqual({ documents: 0, chunks: 0, analyses: 0 })
    expect(await ai.restore('/tmp/b.json')).toEqual({ documents: 0, chunks: 0, analyses: 0 })
  })
})

describe('AiSession — pull de modelo', () => {
  it('baixa e devolve o nome confirmado pelo worker', async () => {
    const { port, calls } = makeWorker({ ai_pull_model: { model: 'qwen3:8b' } })
    expect(await session(port).pullModel('qwen3:8b')).toEqual({ model: 'qwen3:8b' })
    expect(calls.find((command) => command.cmd === 'ai_pull_model')).toMatchObject({
      params: { model: 'qwen3:8b' }
    })
  })

  it('sem confirmação do worker, mantém o nome pedido', async () => {
    const { port } = makeWorker({ ai_pull_model: {} })
    expect(await session(port).pullModel('qwen3:8b')).toEqual({ model: 'qwen3:8b' })
  })
})
