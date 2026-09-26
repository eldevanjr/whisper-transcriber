import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIG_KEY,
  mergeJsonConfig,
  readJsonConfig,
  removeJsonConfig,
  type JsonObject
} from '../../../../src/main/mcp/clients/json-config'
import { makeTempDir } from '../../../helpers/tmp'

let root: string
let file: string

beforeEach(async () => {
  root = await makeTempDir()
  file = join(root, 'nested', 'mcp.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readObject(path = file): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  return parsed as JsonObject
}

describe('readJsonConfig', () => {
  it('devolve null quando o arquivo não existe', async () => {
    expect(await readJsonConfig(file)).toBeNull()
  })

  it('trata arquivo vazio ou só com espaços como objeto vazio', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '   \n', 'utf8')
    expect(await readJsonConfig(file)).toEqual({})
  })

  it('lê um objeto JSON', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '{"a":1}', 'utf8')
    expect(await readJsonConfig(file)).toEqual({ a: 1 })
  })

  it('JSON inválido vira CONFIG_INVALID', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '{ nao fechado', 'utf8')
    await expect(readJsonConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('JSON válido que não é objeto vira CONFIG_INVALID', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '[1,2]', 'utf8')
    await expect(readJsonConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('JSONC com comentários vira CONFIG_HAS_COMMENTS quando permitido', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '// nota\n{ "a": 1 }\n', 'utf8')
    await expect(readJsonConfig(file, { allowComments: true })).rejects.toMatchObject({
      code: 'CONFIG_HAS_COMMENTS'
    })
  })

  it('comentários em cliente JSON comum viram CONFIG_INVALID', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '// nota\n{ "a": 1 }\n', 'utf8')
    await expect(readJsonConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('não confunde // dentro de string com comentário', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '{"url":"http://x/y"}', 'utf8')
    expect(await readJsonConfig(file, { allowComments: true })).toEqual({ url: 'http://x/y' })
  })

  it('JSONC inválido sem comentários vira CONFIG_INVALID', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '{ quebrado', 'utf8')
    await expect(readJsonConfig(file, { allowComments: true })).rejects.toMatchObject({
      code: 'CONFIG_INVALID'
    })
  })

  it('strings JSON não contam como comentário', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '"a" lixo', 'utf8')
    await expect(readJsonConfig(file, { allowComments: true })).rejects.toMatchObject({
      code: 'CONFIG_INVALID'
    })
  })

  it('JSON nulo ou numérico vira CONFIG_INVALID', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, 'null', 'utf8')
    await expect(readJsonConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await writeFile(file, '5', 'utf8')
    await expect(readJsonConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })

  it('erro de leitura que não é ENOENT vira erro do app', async () => {
    const dir = join(root, 'pasta')
    await mkdir(dir, { recursive: true })
    await expect(readJsonConfig(dir)).rejects.toMatchObject({ code: 'INTERNAL' })
  })
})

describe('mergeJsonConfig', () => {
  it('cria arquivo e pasta quando não existem', async () => {
    await mergeJsonConfig(file, (data) => {
      data.mcpServers = { [CONFIG_KEY]: { command: '/l' } }
    })
    expect(await readObject()).toEqual({ mcpServers: { [CONFIG_KEY]: { command: '/l' } } })
  })

  it('preserva os outros servidores e a ordem, e faz backup', async () => {
    const original = JSON.stringify(
      { mcpServers: { primeiro: { command: 'a' }, segundo: { command: 'b' } }, extra: true },
      null,
      2
    )
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, original, 'utf8')
    await mergeJsonConfig(file, (data) => {
      if (typeof data.mcpServers === 'object' && data.mcpServers !== null) {
        ;(data.mcpServers as Record<string, unknown>)[CONFIG_KEY] = { command: '/l' }
      }
    })
    const text = await readFile(file, 'utf8')
    expect(text.indexOf('primeiro')).toBeLessThan(text.indexOf('segundo'))
    expect(text.indexOf('segundo')).toBeLessThan(text.indexOf(CONFIG_KEY))
    expect(await readObject()).toEqual({
      mcpServers: {
        primeiro: { command: 'a' },
        segundo: { command: 'b' },
        [CONFIG_KEY]: { command: '/l' }
      },
      extra: true
    })
    expect(await readFile(`${file}.bak`, 'utf8')).toBe(original)
  })

  it('não cria backup quando o arquivo não existia', async () => {
    await mergeJsonConfig(file, () => undefined)
    await expect(readFile(`${file}.bak`, 'utf8')).rejects.toThrow()
  })

  it('trata arquivo vazio como objeto vazio e faz backup vazio', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '   ', 'utf8')
    await mergeJsonConfig(file, (data) => {
      data.extra = true
    })
    expect(await readObject()).toEqual({ extra: true })
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('   ')
  })

  it('JSON inválido não é tocado nem ganha backup', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, '{ quebrado', 'utf8')
    await expect(mergeJsonConfig(file, () => undefined)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    expect(await readFile(file, 'utf8')).toBe('{ quebrado')
    await expect(readFile(`${file}.bak`, 'utf8')).rejects.toThrow()
  })

  it('JSONC com comentários não é tocado quando permitido', async () => {
    const text = '// nota\n{ "mcp": {} }\n'
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, text, 'utf8')
    await expect(
      mergeJsonConfig(file, () => undefined, { allowComments: true })
    ).rejects.toMatchObject({ code: 'CONFIG_HAS_COMMENTS' })
    expect(await readFile(file, 'utf8')).toBe(text)
    await expect(readFile(`${file}.bak`, 'utf8')).rejects.toThrow()
  })
})

describe('removeJsonConfig', () => {
  it('remove só a nossa chave e mantém os outros servidores', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { outro: { command: 'x' }, [CONFIG_KEY]: { command: '/l' } } }),
      'utf8'
    )
    await removeJsonConfig(file, (data) => {
      const servers = data.mcpServers as Record<string, unknown> | undefined
      if (servers) Reflect.deleteProperty(servers, CONFIG_KEY)
    })
    expect(await readObject()).toEqual({ mcpServers: { outro: { command: 'x' } } })
    expect(await readFile(`${file}.bak`, 'utf8')).toBeTruthy()
  })

  it('mantém mcpServers vazio quando era o único servidor', async () => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ mcpServers: { [CONFIG_KEY]: { command: '/l' } } }), 'utf8')
    await removeJsonConfig(file, (data) => {
      const servers = data.mcpServers as Record<string, unknown> | undefined
      if (servers) Reflect.deleteProperty(servers, CONFIG_KEY)
    })
    expect(await readObject()).toEqual({ mcpServers: {} })
  })

  it('não cria arquivo nem backup quando o arquivo não existe', async () => {
    await removeJsonConfig(file, () => undefined)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    await expect(readFile(`${file}.bak`, 'utf8')).rejects.toThrow()
  })
})
