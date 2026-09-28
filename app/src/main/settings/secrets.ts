import { z } from 'zod'
import { AI_SECRET_KINDS, type AiSecretKind, type AiSecretsStatus } from '../../shared/ipc'
import { isNotFound, readJson, writeJsonAtomic } from '../fs-utils'

/**
 * Criptografia do sistema (Electron `safeStorage`). Injetada para os testes.
 * `available()` false = sem cofre; nesse caso a senha fica só em memória.
 */
export interface StringCipher {
  available(): boolean
  encrypt(text: string): string
  decrypt(token: string): string
}

/** kind → token criptografado (base64). */
const VaultSchema = z.record(z.string(), z.string())

/**
 * Guarda as senhas de IA criptografadas pelo SO, fora das settings.
 * Sem criptografia disponível, o valor não vai para o disco (perde-se ao sair).
 */
export class SecretsStore {
  private readonly encrypted = new Map<AiSecretKind, string>()
  private readonly volatile = new Map<AiSecretKind, string>()

  private constructor(
    private readonly path: string,
    private readonly cipher: StringCipher
  ) {}

  static async open(path: string, cipher: StringCipher): Promise<SecretsStore> {
    const store = new SecretsStore(path, cipher)
    try {
      const parsed = VaultSchema.safeParse(await readJson(path))
      if (parsed.success) {
        for (const kind of AI_SECRET_KINDS) {
          const token = parsed.data[kind]
          if (token !== undefined) store.encrypted.set(kind, token)
        }
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    return store
  }

  available(): boolean {
    return this.cipher.available()
  }

  get(kind: AiSecretKind): string | null {
    const token = this.encrypted.get(kind)
    if (token !== undefined) {
      try {
        return this.cipher.decrypt(token)
      } catch {
        return null
      }
    }
    return this.volatile.get(kind) ?? null
  }

  has(kind: AiSecretKind): boolean {
    return this.encrypted.has(kind) || this.volatile.has(kind)
  }

  async set(kind: AiSecretKind, value: string): Promise<AiSecretsStatus> {
    if (value === '') return this.clear(kind)
    if (this.cipher.available()) {
      this.encrypted.set(kind, this.cipher.encrypt(value))
      this.volatile.delete(kind)
      await this.persist()
    } else {
      this.volatile.set(kind, value)
    }
    return this.status()
  }

  async clear(kind: AiSecretKind): Promise<AiSecretsStatus> {
    this.encrypted.delete(kind)
    this.volatile.delete(kind)
    await this.persist()
    return this.status()
  }

  status(): AiSecretsStatus {
    return {
      available: this.available(),
      postgres: this.has('postgres'),
      container: this.has('container')
    }
  }

  private persist(): Promise<void> {
    return writeJsonAtomic(this.path, Object.fromEntries(this.encrypted))
  }
}
