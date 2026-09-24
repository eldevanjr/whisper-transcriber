import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../../../src/main/settings/store'
import { AppError } from '../../../src/shared/errors'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { makeTempDir } from '../../helpers/tmp'

async function paths() {
  const dir = await makeTempDir()
  return { settings: join(dir, 'settings.json'), settingsBackup: join(dir, 'settings.bak.json') }
}

describe('SettingsStore', () => {
  it('sem arquivo usa os padrões sem gravar nada', async () => {
    const p = await paths()
    const store = await SettingsStore.open(p)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(store.recovered).toBe(false)
  })

  it('update valida, grava, notifica e só muda o que veio no patch', async () => {
    const p = await paths()
    const store = await SettingsStore.open(p)
    const listener = vi.fn()
    const unsubscribe = store.onChange(listener)
    const next = await store.update({ theme: 'dark', model: 'medium', device: undefined })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', model: 'medium' })
    expect(JSON.parse(await readFile(p.settings, 'utf8'))).toEqual(next)
    expect(listener).toHaveBeenCalledWith(next)
    unsubscribe()
    await store.update({ theme: 'light' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect((await SettingsStore.open(p)).get().theme).toBe('light')
  })

  it('patch inválido lança INVALID_REQUEST e não altera nada', async () => {
    const store = await SettingsStore.open(await paths())
    await expect(store.update({ device: 'tpu' })).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'INVALID_REQUEST'
    )
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it.each([['{ corrompido'], ['{"version":1,"theme":"roxo"}']])(
    'arquivo inválido (%s) vira backup e volta ao padrão',
    async (content) => {
      const p = await paths()
      await writeFile(p.settings, content)
      const store = await SettingsStore.open(p)
      expect(store.recovered).toBe(true)
      expect(store.get()).toEqual(DEFAULT_SETTINGS)
      expect(await readFile(p.settingsBackup, 'utf8')).toBe(content)
      expect(JSON.parse(await readFile(p.settings, 'utf8'))).toEqual(DEFAULT_SETTINGS)
    }
  )

  it('arquivo válido é carregado', async () => {
    const p = await paths()
    await writeFile(p.settings, JSON.stringify({ ...DEFAULT_SETTINGS, uiLanguage: 'es' }))
    expect((await SettingsStore.open(p)).get().uiLanguage).toBe('es')
  })

  it('updates simultâneos são aplicados em ordem e o arquivo continua válido', async () => {
    const p = await paths()
    const store = await SettingsStore.open(p)
    await Promise.all([
      store.update({ theme: 'light' }),
      store.update({ uiLanguage: 'es' }),
      store.update({ device: 'cuda' }),
      store.update({ theme: 'dark' })
    ])
    const onDisk = JSON.parse(await readFile(p.settings, 'utf8')) as Record<string, unknown>
    expect(onDisk).toMatchObject({ theme: 'dark', uiLanguage: 'es', device: 'cuda' })
    expect(store.get()).toEqual(onDisk)
  })

  it('um update inválido na fila não impede os seguintes', async () => {
    const store = await SettingsStore.open(await paths())
    const results = await Promise.allSettled([
      store.update({ theme: 'roxo' }),
      store.update({ theme: 'light' })
    ])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(store.get().theme).toBe('light')
  })
})
