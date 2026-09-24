import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

export interface SentCommand {
  id: string
  cmd: string
  params?: Record<string, unknown>
}

export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  private written = ''

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8')
    })
  }

  commands(): SentCommand[] {
    return this.written
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as SentCommand)
  }

  lastCommand(): SentCommand {
    const all = this.commands()
    const last = all.at(-1)
    if (!last) throw new Error('nenhum comando enviado')
    return last
  }

  send(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`)
  }

  ready(version = '0.1.0', protocol = 3): void {
    this.send({ type: 'ready', protocol, version })
  }

  crash(): void {
    this.emit('exit', 1, null)
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

/** Espera o event loop processar os dados escritos nas streams. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
