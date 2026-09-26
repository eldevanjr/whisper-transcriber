import { readFile } from 'node:fs/promises'
import { AppError, toAppError } from '../../../shared/errors'
import { isNotFound, writeFileAtomic } from '../../fs-utils'

/** Nome da entrada do Whisper Transcriber em todas as configs dos clientes (spec §11.1). */
export const CONFIG_KEY = 'whisper-transcriber'

export type JsonObject = Record<string, unknown>

export interface JsonConfigOptions {
  /** Clientes JSONC (OpenCode, VS Code) aceitam comentários, mas nós não os reescrevemos. */
  allowComments?: boolean
}

export type JsonMutator = (data: JsonObject) => void

/** Lê o arquivo; `null` quando ainda não existe; erro claro quando não dá para confiar no conteúdo. */
export async function readJsonConfig(
  file: string,
  options: JsonConfigOptions = {}
): Promise<JsonObject | null> {
  const text = await readText(file)
  if (text === null) return null
  if (text.trim() === '') return {}
  return asObject(parseJson(text, options.allowComments === true))
}

/** Junta/atualiza uma chave preservando as demais e a ordem; cria arquivo e pasta se preciso. */
export async function mergeJsonConfig(
  file: string,
  mutate: JsonMutator,
  options: JsonConfigOptions = {}
): Promise<void> {
  await update(file, mutate, options, true)
}

/** Remove uma chave; nunca apaga o arquivo (objeto vazio continua vazio). */
export async function removeJsonConfig(
  file: string,
  mutate: JsonMutator,
  options: JsonConfigOptions = {}
): Promise<void> {
  await update(file, mutate, options, false)
}

/** Confere se `value` é um objeto JSON simples (não nulo, não vetor). */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function update(
  file: string,
  mutate: JsonMutator,
  options: JsonConfigOptions,
  create: boolean
): Promise<void> {
  const text = await readText(file)
  if (text === null && !create) return
  const data =
    text === null || text.trim() === '' ? {} : asObject(parseJson(text, options.allowComments === true))
  mutate(data)
  if (text !== null) await writeFileAtomic(`${file}.bak`, text)
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return null
    throw toAppError(error)
  }
}

function parseJson(text: string, allowComments: boolean): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    if (allowComments && hasComments(text)) {
      throw new AppError(
        'CONFIG_HAS_COMMENTS',
        'The client config has comments; use the manual config to avoid losing them.'
      )
    }
    throw new AppError('CONFIG_INVALID', 'The client config is not valid JSON.')
  }
}

function asObject(value: unknown): JsonObject {
  if (isPlainObject(value)) return value
  throw new AppError('CONFIG_INVALID', 'The client config must be a JSON object.')
}

/**
 * Detecta comentários fora de strings sem desmontar strings que contenham `//` (ex.: URLs).
 * O grupo de captura só é preenchido quando o casamento é de fato um comentário.
 */
const COMMENT = /\\"|"(?:\\"|[^"])*"|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g

function hasComments(text: string): boolean {
  for (const match of text.matchAll(COMMENT)) {
    if (match[1] !== undefined) return true
  }
  return false
}
