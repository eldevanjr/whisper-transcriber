import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FlagsStore } from '../../../src/main/background/flags'
import { makeTempDir } from '../../helpers/tmp'

describe('FlagsStore', () => {
  it('sem arquivo: padrão; set grava e sobrevive a reabrir', async () => {
    const path = join(await makeTempDir(), 'state.json')
    const store = await FlagsStore.open(path)
    expect(store.get()).toEqual({ hiddenHintShown: false })
    await store.set({ hiddenHintShown: true })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ hiddenHintShown: true })
    expect((await FlagsStore.open(path)).get().hiddenHintShown).toBe(true)
  })

  it('arquivo estragado ou de outro formato: padrão', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'a.json'), '{nada')
    await writeFile(join(dir, 'b.json'), '{"hiddenHintShown": "sim"}')
    expect((await FlagsStore.open(join(dir, 'a.json'))).get().hiddenHintShown).toBe(false)
    expect((await FlagsStore.open(join(dir, 'b.json'))).get().hiddenHintShown).toBe(false)
  })
})
