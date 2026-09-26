import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { z } from 'zod'
import { AppError } from '../../shared/errors'
import {
  ActivitySnapshotSchema,
  BridgeResponseSchema,
  JobProgressSchema,
  type ActivitySnapshot,
  type BridgeRequest,
  type BridgeResponse,
  type JobProgress
} from '../../shared/mcp'
import type { AppPaths } from '../paths'
import type { BridgePort } from './server'

/** `bridge.json` escrito pelo app (spec §7.1). */
export const BridgeInfoSchema = z.object({
  address: z.string(),
  token: z.string(),
  pid: z.number().int(),
  version: z.string().optional()
})
export type BridgeInfo = z.infer<typeof BridgeInfoSchema>

const PingDataSchema = z.object({ appVersion: z.string(), ready: z.boolean() })
const CreatedJobSchema = z.object({ id: z.uuid(), position: z.number().optional() })

const AUTH_RID = 1
const REQUEST_RID = 2
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_POLL_MS = 1000

export interface BridgeClientOptions {
  timeoutMs?: number
  pollMs?: number
}

/** O que a ponte do processo MCP precisa do cliente; facilita o teste do adaptador. */
export interface BridgeClientLike {
  connect(): Promise<{ appVersion: string; ready: boolean }>
  activity(): Promise<ActivitySnapshot>
  status(id: string): Promise<JobProgress | null>
  transcribe(path: string, client: string): Promise<{ id: string; position?: number }>
}

/**
 * Fala com o app aberto pela ponte (spec §7.3): cada chamada abre uma conexão, autentica e
 * envia a requisição. Lê `bridge.json` sempre de novo, então funciona depois de o app reabrir.
 */
export class BridgeClient implements BridgeClientLike {
  private readonly timeoutMs: number
  private readonly pollMs: number

  constructor(
    private readonly paths: AppPaths,
    options: BridgeClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
  }

  async connect(): Promise<{ appVersion: string; ready: boolean }> {
    return PingDataSchema.parse(await this.call({ type: 'ping', rid: REQUEST_RID }))
  }

  async activity(): Promise<ActivitySnapshot> {
    return ActivitySnapshotSchema.parse(await this.call({ type: 'activity', rid: REQUEST_RID }))
  }

  async status(id: string): Promise<JobProgress | null> {
    return JobProgressSchema.nullable().parse(
      await this.call({ type: 'status', rid: REQUEST_RID, id })
    )
  }

  async transcribe(path: string, client: string): Promise<{ id: string; position?: number }> {
    return CreatedJobSchema.parse(
      await this.call({ type: 'transcribe', rid: REQUEST_RID, path, client })
    )
  }

  /** Consulta o progresso a cada `pollMs` (spec §9.8); o retorno cancela. Null = terminou/saiu. */
  subscribeProgress(id: string, cb: (progress: JobProgress | null) => void): () => void {
    const timer = setInterval(() => {
      void this.status(id).then(cb, () => undefined)
    }, this.pollMs)
    return () => {
      clearInterval(timer)
    }
  }

  private async call(request: BridgeRequest): Promise<unknown> {
    const info = await this.readInfo()
    return new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(info.address)
      let buffer = ''
      const finish = (action: () => void): void => {
        clearTimeout(timer)
        socket.destroy()
        action()
      }
      const timer = setTimeout(() => {
        finish(() => {
          reject(unavailable())
        })
      }, this.timeoutMs)
      socket.setEncoding('utf8')
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ type: 'auth', rid: AUTH_RID, token: info.token })}\n`)
        socket.write(`${JSON.stringify(request)}\n`)
      })
      socket.on('error', () => {
        finish(() => {
          reject(unavailable())
        })
      })
      socket.on('data', (chunk: string) => {
        buffer += chunk
        this.consume(buffer, request, finish, resolve, reject, (rest) => {
          buffer = rest
        })
      })
    })
  }

  private consume(
    buffer: string,
    request: BridgeRequest,
    finish: (action: () => void) => void,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
    setBuffer: (rest: string) => void
  ): void {
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const message = parseResponse(line)
      if (!message) {
        finish(() => {
          reject(unavailable())
        })
        return
      }
      if (message.rid === AUTH_RID) {
        if (message.type === 'error') {
          finish(() => {
            reject(fromInfo(message.error))
          })
          return
        }
      } else if (message.rid === request.rid) {
        settle(message, finish, resolve, reject)
      }
    }
    setBuffer(buffer)
  }

  private async readInfo(): Promise<BridgeInfo> {
    try {
      const parsed = BridgeInfoSchema.safeParse(
        JSON.parse(await readFile(this.paths.mcpBridgeInfo, 'utf8'))
      )
      if (!parsed.success) throw new Error('invalid bridge.json')
      return parsed.data
    } catch {
      throw unavailable()
    }
  }
}

/**
 * Adaptador para as ferramentas MCP (spec §9.8): só transcrever abre o app; as leituras de estado
 * nunca abrem. A espera com `wait` é feita pelas ferramentas, não aqui.
 */
export function createLiveBridge(deps: {
  client: BridgeClientLike
  ensureRunning: () => Promise<void>
}): BridgePort {
  return {
    activity: () => deps.client.activity(),
    status: (id) => deps.client.status(id),
    transcribe: async (path, client) => {
      await deps.ensureRunning()
      const created = await deps.client.transcribe(path, client)
      return {
        id: created.id,
        status: 'queued',
        ...(created.position === undefined ? {} : { position: created.position })
      }
    }
  }
}

function settle(
  message: BridgeResponse,
  finish: (action: () => void) => void,
  resolve: (value: unknown) => void,
  reject: (error: unknown) => void
): void {
  if (message.type === 'ok') {
    finish(() => {
      resolve(message.data)
    })
  } else {
    finish(() => {
      reject(fromInfo(message.error))
    })
  }
}

function parseResponse(line: string): BridgeResponse | null {
  try {
    const parsed = BridgeResponseSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function fromInfo(info: { code: string; message: string; detail?: string }): AppError {
  return new AppError(info.code as AppError['code'], info.message, info.detail)
}

function unavailable(): AppError {
  return new AppError('WORKER_UNAVAILABLE', 'Whisper Transcriber is not running')
}
