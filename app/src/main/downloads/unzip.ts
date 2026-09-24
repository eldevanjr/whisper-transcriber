import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { AppError } from '../../shared/errors'

/** Destino seguro de uma entrada do wheel; null = entrada que não interessa (fora de nvidia/ ou pasta). */
export function resolveEntry(destDir: string, entryName: string): string | null {
  if (!entryName.startsWith('nvidia/') || entryName.endsWith('/')) return null
  const root = resolve(destDir)
  const target = resolve(root, entryName)
  if (!target.startsWith(root + sep)) {
    throw new AppError('DOWNLOAD_FAILED', 'Entrada inválida no pacote', entryName)
  }
  return target
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error) reject(error)
      else resolvePromise(zip)
    })
  })
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = (): void => {
      zip.removeListener('entry', onEntry)
      zip.removeListener('end', onEnd)
      zip.removeListener('error', onError)
    }
    const onEntry = (entry: Entry): void => {
      cleanup()
      resolvePromise(entry)
    }
    const onEnd = (): void => {
      cleanup()
      resolvePromise(null)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    zip.once('entry', onEntry)
    zip.once('end', onEnd)
    zip.once('error', onError)
    zip.readEntry()
  })
}

function openStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error)
      else resolvePromise(stream)
    })
  })
}

export async function extractNvidiaLibs(zipPath: string, destDir: string): Promise<number> {
  let zip: ZipFile | undefined
  let count = 0
  try {
    zip = await openZip(zipPath)
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      const target = resolveEntry(destDir, entry.fileName)
      if (target === null) continue
      await mkdir(dirname(target), { recursive: true })
      await pipeline(await openStream(zip, entry), createWriteStream(target))
      count += 1
    }
  } catch (error) {
    // Inclui zip-slip (resolveEntry): tudo que impede a extração vira "pacote corrompido".
    throw new AppError('DOWNLOAD_FAILED', 'Pacote CUDA corrompido', String(error))
  } finally {
    zip?.close()
  }
  return count
}
