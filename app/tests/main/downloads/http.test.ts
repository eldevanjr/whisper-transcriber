import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  downloadFile,
  downloadWithRetry,
  fetchAllowed,
  type DownloadOptions
} from '../../../src/main/downloads/http'
import { pathExists } from '../../../src/main/fs-utils'
import { AppError } from '../../../src/shared/errors'
import { makeTempDir } from '../../helpers/tmp'

const server = setupServer()
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const BODY = Buffer.from('conteúdo do modelo '.repeat(500))
const SHA = createHash('sha256').update(BODY).digest('hex')
const URL_OK = 'https://huggingface.co/org/m/resolve/abc/model.bin'

function serveWithRange(url = URL_OK, body = BODY) {
  const hits: (string | null)[] = []
  server.use(
    http.get(url, ({ request }) => {
      const range = request.headers.get('range')
      hits.push(range)
      const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0
      return new HttpResponse(body.subarray(start), { status: range ? 206 : 200 })
    })
  )
  return hits
}

async function options(overrides: Partial<DownloadOptions> = {}): Promise<DownloadOptions> {
  const dir = await makeTempDir()
  return {
    url: URL_OK,
    dest: join(dir, 'model.bin'),
    size: BODY.length,
    sha256: SHA,
    fetch: (url, init) => fetch(url, init),
    ...overrides
  }
}

const isCode = (code: string) => (e: unknown) => e instanceof AppError && e.code === code

describe('downloadFile', () => {
  it('baixa, verifica o hash e renomeia; informa progresso', async () => {
    serveWithRange()
    const progress: number[] = []
    const o = await options({ onProgress: (n) => progress.push(n) })
    await downloadFile(o)
    expect(await readFile(o.dest)).toEqual(BODY)
    expect(await pathExists(`${o.dest}.part`)).toBe(false)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(BODY.length)
  })

  it('retoma um .part existente com Range', async () => {
    const hits = serveWithRange()
    const o = await options()
    await writeFile(`${o.dest}.part`, BODY.subarray(0, 1000))
    await downloadFile(o)
    expect(hits).toEqual(['bytes=1000-'])
    expect(await readFile(o.dest)).toEqual(BODY)
  })

  it('servidor que ignora Range (200) recomeça do zero', async () => {
    server.use(http.get(URL_OK, () => new HttpResponse(BODY, { status: 200 })))
    const o = await options()
    await writeFile(`${o.dest}.part`, Buffer.from('lixo antigo'))
    await downloadFile(o)
    expect(await readFile(o.dest)).toEqual(BODY)
  })

  it('.part já completo só verifica', async () => {
    const hits = serveWithRange()
    const o = await options()
    await writeFile(`${o.dest}.part`, BODY)
    await downloadFile(o)
    expect(hits).toEqual([])
    expect(await readFile(o.dest)).toEqual(BODY)
  })

  it('.part maior que o esperado é descartado', async () => {
    const hits = serveWithRange()
    const o = await options()
    await writeFile(`${o.dest}.part`, Buffer.concat([BODY, Buffer.from('x')]))
    await downloadFile(o)
    expect(hits).toEqual([null])
  })

  it('hash diferente → HASH_MISMATCH e .part apagado', async () => {
    serveWithRange()
    const o = await options({ sha256: '0'.repeat(64) })
    await expect(downloadFile(o)).rejects.toSatisfy(isCode('HASH_MISMATCH'))
    expect(await pathExists(`${o.dest}.part`)).toBe(false)
    expect(await pathExists(o.dest)).toBe(false)
  })

  it('HTTP de erro ou resposta sem corpo → DOWNLOAD_FAILED', async () => {
    server.use(http.get(URL_OK, () => new HttpResponse(null, { status: 503 })))
    await expect(downloadFile(await options())).rejects.toSatisfy(isCode('DOWNLOAD_FAILED'))
    server.resetHandlers()
    server.use(http.get(URL_OK, () => new HttpResponse(null, { status: 204 })))
    await expect(downloadFile(await options())).rejects.toSatisfy(isCode('DOWNLOAD_FAILED'))
  })
})

describe('fetchAllowed', () => {
  const plain = (url: string, init?: RequestInit) => fetch(url, init)

  it('segue redirecionamento para host permitido', async () => {
    server.use(
      http.get(
        URL_OK,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://cdn-lfs.huggingface.co/blob' }
          })
      ),
      http.get('https://cdn-lfs.huggingface.co/blob', () => HttpResponse.text('ok'))
    )
    expect(await (await fetchAllowed(URL_OK, {}, plain)).text()).toBe('ok')
  })

  it('bloqueia redirecionamento para host fora da lista', async () => {
    server.use(
      http.get(
        URL_OK,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://portal-do-hotel.example/login' }
          })
      )
    )
    await expect(fetchAllowed(URL_OK, {}, plain)).rejects.toSatisfy(isCode('HOST_NOT_ALLOWED'))
  })

  it('bloqueia http:// e hosts desconhecidos direto', async () => {
    await expect(fetchAllowed('http://huggingface.co/x', {}, plain)).rejects.toSatisfy(
      isCode('HOST_NOT_ALLOWED')
    )
    await expect(fetchAllowed('https://evil.example/x', {}, plain)).rejects.toSatisfy(
      isCode('HOST_NOT_ALLOWED')
    )
  })

  it('redirecionamento sem Location ou em excesso → DOWNLOAD_FAILED', async () => {
    server.use(http.get(URL_OK, () => new HttpResponse(null, { status: 302 })))
    await expect(fetchAllowed(URL_OK, {}, plain)).rejects.toSatisfy(isCode('DOWNLOAD_FAILED'))
    server.resetHandlers()
    server.use(
      http.get(URL_OK, () => new HttpResponse(null, { status: 301, headers: { Location: URL_OK } }))
    )
    await expect(fetchAllowed(URL_OK, {}, plain)).rejects.toSatisfy(isCode('DOWNLOAD_FAILED'))
  })
})

describe('downloadWithRetry', () => {
  it('tenta de novo em falha de rede com espera crescente', async () => {
    let calls = 0
    server.use(
      http.get(URL_OK, () => {
        calls += 1
        return calls < 3 ? HttpResponse.error() : new HttpResponse(BODY)
      })
    )
    const sleep = vi.fn(() => Promise.resolve())
    const o = await options()
    await downloadWithRetry(o, { sleep })
    expect(sleep.mock.calls).toEqual([[1000], [2000]])
    expect(await readFile(o.dest)).toEqual(BODY)
  })

  it('desiste depois de 3 novas tentativas', async () => {
    server.use(http.get(URL_OK, () => HttpResponse.error()))
    const sleep = vi.fn(() => Promise.resolve())
    await expect(downloadWithRetry(await options(), { sleep })).rejects.toSatisfy(
      isCode('DOWNLOAD_FAILED')
    )
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('hash errado refaz uma única vez', async () => {
    serveWithRange()
    const sleep = vi.fn(() => Promise.resolve())
    await expect(
      downloadWithRetry(await options({ sha256: '0'.repeat(64) }), { sleep })
    ).rejects.toSatisfy(isCode('HASH_MISMATCH'))
    expect(sleep.mock.calls).toEqual([[0]])
  })

  it('host bloqueado não tenta de novo', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    await expect(
      downloadWithRetry(await options({ url: 'https://evil.example/m' }), { sleep })
    ).rejects.toSatisfy(isCode('HOST_NOT_ALLOWED'))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('cancelado vira CANCELED sem novas tentativas', async () => {
    serveWithRange()
    const controller = new AbortController()
    controller.abort()
    const sleep = vi.fn(() => Promise.resolve())
    await expect(
      downloadWithRetry(await options({ signal: controller.signal }), { sleep })
    ).rejects.toSatisfy(isCode('CANCELED'))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('usa o sleep padrão (setTimeout) quando não informado', async () => {
    let calls = 0
    server.use(
      http.get(URL_OK, () => {
        calls += 1
        return calls < 2 ? HttpResponse.error() : new HttpResponse(BODY)
      })
    )
    await downloadWithRetry(await options(), { delays: [1] })
    expect(calls).toBe(2)
  })
})
