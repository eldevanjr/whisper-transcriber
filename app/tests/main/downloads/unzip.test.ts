import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractNvidiaLibs, resolveEntry } from '../../../src/main/downloads/unzip'
import { pathExists } from '../../../src/main/fs-utils'
import { AppError } from '../../../src/shared/errors'
import { makeTempDir } from '../../helpers/tmp'
import { makeWheel } from '../../helpers/zip'

describe('resolveEntry', () => {
  it('só aceita arquivos dentro de nvidia/', () => {
    expect(resolveEntry('/c', 'nvidia/cublas/lib/libcublas.so.12')).toBe(
      join('/c', 'nvidia', 'cublas', 'lib', 'libcublas.so.12')
    )
    expect(resolveEntry('/c', 'nvidia/cublas/')).toBeNull()
    expect(resolveEntry('/c', 'nvidia_cublas-12.dist-info/RECORD')).toBeNull()
  })

  it('bloqueia zip-slip', () => {
    expect(() => resolveEntry('/c', 'nvidia/../../etc/passwd')).toThrow(AppError)
  })
})

describe('extractNvidiaLibs', () => {
  it('extrai só as bibliotecas NVIDIA', async () => {
    const dir = await makeTempDir()
    const wheel = join(dir, 'pkg.whl')
    await makeWheel(wheel, {
      'nvidia/': '',
      'nvidia/cublas/lib/libcublas.so.12': 'binário',
      'nvidia/cublas/bin/cublas64_12.dll': 'dll',
      'nvidia_cublas_cu12-12.dist-info/METADATA': 'meta'
    })
    const dest = join(dir, 'cuda')
    expect(await extractNvidiaLibs(wheel, dest)).toBe(2)
    expect(await readFile(join(dest, 'nvidia', 'cublas', 'lib', 'libcublas.so.12'), 'utf8')).toBe(
      'binário'
    )
    expect(await pathExists(join(dest, 'nvidia_cublas_cu12-12.dist-info'))).toBe(false)
  })

  it('pacote corrompido → DOWNLOAD_FAILED', async () => {
    const dir = await makeTempDir()
    const wheel = join(dir, 'ruim.whl')
    await writeFile(wheel, 'isto não é zip')
    await expect(extractNvidiaLibs(wheel, join(dir, 'cuda'))).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'DOWNLOAD_FAILED'
    )
  })

  it.each([
    ['cabeçalho local', 'PK\u0003\u0004'],
    ['diretório central', 'PK\u0001\u0002']
  ])('entrada com %s corrompido → DOWNLOAD_FAILED', async (_label, signature) => {
    const dir = await makeTempDir()
    const wheel = join(dir, 'w.whl')
    await makeWheel(wheel, { 'nvidia/cublas/lib/libcublas.so.12': 'binário' })
    const bytes = await readFile(wheel)
    const at = bytes.indexOf(Buffer.from(signature, 'latin1'))
    bytes[at + 2] = 0x00 // quebra a assinatura
    await writeFile(wheel, bytes)
    await expect(extractNvidiaLibs(wheel, join(dir, 'cuda'))).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'DOWNLOAD_FAILED'
    )
  })
})
