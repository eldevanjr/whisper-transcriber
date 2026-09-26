import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { McpActivityLineSchema, type McpActivityLine } from '../../shared/mcp'

/** `activity.jsonl` guarda no máximo 500 linhas; ao passar disso mantém as 500 mais recentes. */
const MAX_LINES = 500

/**
 * Registro de uso das IAs em `userData/mcp/activity.jsonl` (spec §12): só cliente, ferramenta e
 * o item, nunca o conteúdo da transcrição. Cada linha é JSON com o campo `at` em ISO 8601.
 */
export class ActivityLog {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Acrescenta uma linha; se passar de 500, reescreve o arquivo com as 500 mais recentes. */
  async record(line: Omit<McpActivityLine, 'at'>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const entry: McpActivityLine = { at: this.now().toISOString(), ...line }
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8')
    await this.trim()
  }

  /** As mais recentes primeiro, no máximo `limit` (padrão 50). */
  async recent(limit = 50): Promise<McpActivityLine[]> {
    const lines = await this.readAll()
    return lines.slice(Math.max(0, lines.length - limit)).reverse()
  }

  /** Horário da última linha válida de cada cliente. */
  async lastUseByClient(): Promise<Map<string, string>> {
    const latest = new Map<string, string>()
    for (const line of await this.readAll()) {
      const previous = latest.get(line.client)
      if (previous === undefined || line.at > previous) latest.set(line.client, line.at)
    }
    return latest
  }

  private async readAll(): Promise<McpActivityLine[]> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    const lines: McpActivityLine[] = []
    for (const text of content.split('\n')) {
      const line = parseLine(text)
      if (line) lines.push(line)
    }
    return lines
  }

  private async trim(): Promise<void> {
    const lines = await this.readAll()
    if (lines.length <= MAX_LINES) return
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${serialize(lines.slice(-MAX_LINES))}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}

/** Linha vazia, truncada (app fechado no meio da escrita) ou com campos errados é descartada. */
function parseLine(text: string): McpActivityLine | null {
  try {
    const parsed = McpActivityLineSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function serialize(lines: McpActivityLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n')
}
