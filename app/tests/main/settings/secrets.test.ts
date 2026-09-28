import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecretsStore, type StringCipher } from '../../../src/main/settings/secrets'
import { makeTempDir } from '../../helpers/tmp'

function fakeCipher(available = true): StringCipher {
  return {
    available: () => available,
    encrypt: (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`,
    decrypt: (token) => Buffer.from(token.slice(4), 'base64').toString('utf8')
  }
}

async function vaultPath(): Promise<string> {
  return join(await makeTempDir(), 'ai-secrets.json')
}

describe('SecretsStore', () => {
  it('sem arquivo começa vazio', async () => {
    const store = await SecretsStore.open(await vaultPath(), fakeCipher())
    expect(store.status()).toEqual({ available: true, postgres: false, container: false })
    expect(store.get('postgres')).toBeNull()
  })

  it('grava criptografado e lê de volta', async () => {
    const path = await vaultPath()
    const store = await SecretsStore.open(path, fakeCipher())
    const status = await store.set('postgres', 'segredo')
    expect(status.postgres).toBe(true)
    expect(store.get('postgres')).toBe('segredo')
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>
    expect(raw.postgres).not.toContain('segredo')
    expect(raw.postgres).toMatch(/^enc:/)
  })

  it('recarrega do disco', async () => {
    const path = await vaultPath()
    await (await SecretsStore.open(path, fakeCipher())).set('container', 'senha')
    const reopened = await SecretsStore.open(path, fakeCipher())
    expect(reopened.get('container')).toBe('senha')
    expect(reopened.has('container')).toBe(true)
  })

  it('sem cofre guarda só em memória, sem gravar no disco', async () => {
    const path = await vaultPath()
    const store = await SecretsStore.open(path, fakeCipher(false))
    await store.set('postgres', 'volatil')
    expect(store.get('postgres')).toBe('volatil')
    await expect(readFile(path, 'utf8')).rejects.toThrow()
    const reopened = await SecretsStore.open(path, fakeCipher(false))
    expect(reopened.get('postgres')).toBeNull()
  })

  it('valor vazio remove a senha', async () => {
    const path = await vaultPath()
    const store = await SecretsStore.open(path, fakeCipher())
    await store.set('postgres', 'x')
    const status = await store.set('postgres', '')
    expect(status.postgres).toBe(false)
    expect(store.get('postgres')).toBeNull()
  })

  it('clear remove e persiste', async () => {
    const path = await vaultPath()
    const store = await SecretsStore.open(path, fakeCipher())
    await store.set('container', 'x')
    const status = await store.clear('container')
    expect(status.container).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
  })

  it('arquivo corrompido lança', async () => {
    const path = await vaultPath()
    await writeFile(path, 'não é json')
    await expect(SecretsStore.open(path, fakeCipher())).rejects.toThrow()
  })

  it('conteúdo com formato inesperado vira vazio', async () => {
    const path = await vaultPath()
    await writeFile(path, '["nada"]')
    const store = await SecretsStore.open(path, fakeCipher())
    expect(store.status().postgres).toBe(false)
  })

  it('token que não decifra vira null', async () => {
    const path = await vaultPath()
    await (await SecretsStore.open(path, fakeCipher())).set('postgres', 'x')
    const broken: StringCipher = {
      available: () => true,
      encrypt: (text) => text,
      decrypt: () => {
        throw new Error('chave mudou')
      }
    }
    const store = await SecretsStore.open(path, broken)
    expect(store.get('postgres')).toBeNull()
    expect(store.has('postgres')).toBe(true)
  })
})
