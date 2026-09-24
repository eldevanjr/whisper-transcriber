import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dirSize, isNotFound, pathExists, readJson, writeJsonAtomic } from '../../src/main/fs-utils'
import { makeTempDir } from '../helpers/tmp'

describe('fs-utils', () => {
  it('writeJsonAtomic cria pastas, grava e substitui', async () => {
    const file = join(await makeTempDir(), 'a', 'b', 'x.json')
    await writeJsonAtomic(file, { v: 1 })
    await writeJsonAtomic(file, { v: 2, texto: 'ação' })
    expect(await readJson(file)).toEqual({ v: 2, texto: 'ação' })
    expect(await readFile(file, 'utf8')).toMatch(/\n$/)
    expect(await pathExists(`${file}.tmp`)).toBe(false)
  })

  it('writeJsonAtomic simultâneos no mesmo arquivo não corrompem nem deixam temporários', async () => {
    const dir = await makeTempDir()
    const file = join(dir, 'x.json')
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => writeJsonAtomic(file, { n, pad: 'x'.repeat(n * 50) }))
    )
    expect(await readJson(file)).toHaveProperty('n')
    expect((await readdir(dir)).sort()).toEqual(['x.json'])
  })

  it('uma gravação que falha não bloqueia as seguintes no mesmo arquivo', async () => {
    const file = join(await makeTempDir(), 'x.json')
    const broken = writeJsonAtomic(file, { n: 1n }) // BigInt: JSON.stringify lança
    const next = writeJsonAtomic(file, { n: 2 })
    await expect(broken).rejects.toBeInstanceOf(TypeError)
    await next
    expect(await readJson(file)).toEqual({ n: 2 })
  })

  it('pathExists', async () => {
    const dir = await makeTempDir()
    expect(await pathExists(dir)).toBe(true)
    expect(await pathExists(join(dir, 'nada'))).toBe(false)
  })

  it('dirSize soma recursivamente e devolve 0 para pasta inexistente', async () => {
    const dir = await makeTempDir()
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'a'), '12345')
    await writeFile(join(dir, 'sub', 'b'), '123')
    expect(await dirSize(dir)).toBe(8)
    expect(await dirSize(join(dir, 'nada'))).toBe(0)
  })

  it('isNotFound reconhece ENOENT', async () => {
    const error: unknown = await readFile('/nao/existe').catch((e: unknown) => e)
    expect(isNotFound(error)).toBe(true)
    expect(isNotFound(new Error('x'))).toBe(false)
    expect(isNotFound('x')).toBe(false)
  })
})
