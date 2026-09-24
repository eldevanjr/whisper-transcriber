import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const writesInFlight = new Map<string, Promise<void>>()

/**
 * Grava via arquivo temporário + rename. Gravações no mesmo caminho entram em fila
 * (renames simultâneos falham no Windows) e cada uma usa um temporário próprio.
 */
export function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const previous = writesInFlight.get(path) ?? Promise.resolve()
  const write = previous.then(() => writeNow(path, data))
  const settled = write.catch(() => undefined)
  writesInFlight.set(path, settled)
  void settled.then(() => {
    if (writesInFlight.get(path) === settled) writesInFlight.delete(path)
  })
  return write
}

async function writeNow(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function dirSize(path: string): Promise<number> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(path, entry.name)
    total += entry.isDirectory() ? await dirSize(full) : (await stat(full)).size
  }
  return total
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
