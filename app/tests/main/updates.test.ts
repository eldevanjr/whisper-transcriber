import { describe, expect, it, vi } from 'vitest'
import {
  canAutoUpdate,
  checkForUpdate,
  compareVersions,
  createUpdater,
  RELEASES_PAGE,
  RELEASES_URL,
  type AutoUpdaterLike
} from '../../src/main/updates'

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('compareVersions', () => {
  it.each([
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.0', 0],
    ['0.9.9', '1.0.0', -1],
    ['1.2', '1.2.0', 0],
    ['1.2.0', '1.2', 0],
    ['1.10.0', '1.9.0', 1],
    // O repositório fica em 0.0.0-dev: o sufixo de pré-release não pode virar NaN.
    ['0.1.0', '0.0.0-dev', 1],
    ['1.0.0-rc.1', '1.0.0', 0]
  ])('%s vs %s = %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })
})

describe('checkForUpdate', () => {
  it('consulta a última release e compara a versão', async () => {
    const fetch = vi.fn(() =>
      json({
        tag_name: 'v1.2.0',
        html_url: 'https://github.com/eldevanjr/whisper-transcriber/releases/tag/v1.2.0'
      })
    )
    expect(await checkForUpdate('1.0.0', fetch)).toEqual({
      available: true,
      latest: '1.2.0',
      url: 'https://github.com/eldevanjr/whisper-transcriber/releases/tag/v1.2.0',
      mode: 'link'
    })
    expect(fetch).toHaveBeenCalledWith(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' }
    })
  })

  it('mesma versão → available false', async () => {
    const fetch = () => json({ tag_name: '1.0.0', html_url: 'https://github.com/eldevanjr/x' })
    expect((await checkForUpdate('1.0.0', fetch))?.available).toBe(false)
  })

  it.each([
    ['HTTP 404 (repositório privado)', () => json({}, 404)],
    ['resposta inesperada', () => json({ nada: true })],
    ['sem rede', () => Promise.reject(new Error('offline'))]
  ])('%s → null', async (_label, fetch) => {
    expect(await checkForUpdate('1.0.0', fetch)).toBeNull()
  })
})

describe('canAutoUpdate', () => {
  it.each([
    ['win32', {}, true],
    ['linux', { APPIMAGE: '/home/u/Whisper.AppImage' }, true],
    ['linux', {}, false], // .deb: quem atualiza é o gerenciador de pacotes
    ['darwin', {}, false] // sem assinatura o Squirrel.Mac não aplica a atualização
  ])('%s %j → %s', (platform, env, expected) => {
    expect(canAutoUpdate(platform, env)).toBe(expected)
  })
})

class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  listeners = new Map<string, (info: { version: string }) => void>()
  checkForUpdates = vi.fn(() =>
    Promise.resolve<{ updateInfo: { version: string } } | null>({
      updateInfo: { version: '1.1.0' }
    })
  )
  quitAndInstall = vi.fn()
  on(event: 'update-downloaded', listener: (info: { version: string }) => void) {
    this.listeners.set(event, listener)
    return this
  }
}

function updater(platform: string, env: NodeJS.ProcessEnv = {}) {
  const auto = new FakeAutoUpdater()
  const emit = vi.fn()
  const fetch = vi.fn(() =>
    json({
      tag_name: 'v1.1.0',
      html_url: 'https://github.com/eldevanjr/whisper-transcriber/releases/tag/v1.1.0'
    })
  )
  const getAuto = vi.fn(() => auto)
  const service = createUpdater({
    platform,
    env,
    version: '1.0.0',
    fetch,
    autoUpdater: getAuto,
    emit
  })
  return { service, auto, emit, fetch, getAuto }
}

describe('createUpdater', () => {
  it('Windows: baixa em segundo plano, avisa quando pronto e instala ao pedir', async () => {
    const { service, auto, emit, fetch } = updater('win32')
    expect(await service.check()).toEqual({
      available: true,
      latest: '1.1.0',
      url: RELEASES_PAGE,
      mode: 'auto'
    })
    expect(auto.autoDownload).toBe(true)
    expect(auto.autoInstallOnAppQuit).toBe(true) // quem preferir aplica ao fechar
    expect(fetch).not.toHaveBeenCalled()
    auto.listeners.get('update-downloaded')!({ version: '1.1.0' })
    expect(emit).toHaveBeenCalledWith({ type: 'ready', version: '1.1.0' })
    service.install()
    expect(auto.quitAndInstall).toHaveBeenCalled()
  })

  it('configura o electron-updater uma vez só, mesmo checando de novo', async () => {
    const { service, getAuto } = updater('linux', { APPIMAGE: '/a.AppImage' })
    await service.check()
    await service.check()
    expect(getAuto).toHaveBeenCalledTimes(1)
  })

  it('sem novidade (ou sem resposta) no modo automático → available false', async () => {
    const { service, auto } = updater('win32')
    auto.checkForUpdates.mockResolvedValueOnce({ updateInfo: { version: '1.0.0' } })
    expect((await service.check())?.available).toBe(false)
    auto.checkForUpdates.mockResolvedValueOnce(null)
    expect(await service.check()).toEqual({
      available: false,
      latest: '1.0.0',
      url: RELEASES_PAGE,
      mode: 'auto'
    })
  })

  it('macOS sem assinatura e .deb: aviso com link para a página da release', async () => {
    const { service, getAuto } = updater('darwin')
    expect(await service.check()).toMatchObject({ available: true, latest: '1.1.0', mode: 'link' })
    expect(getAuto).not.toHaveBeenCalled()
    service.install() // sem electron-updater não há o que instalar
  })

  it('falha no electron-updater cai no aviso com link', async () => {
    const { service, auto } = updater('win32')
    auto.checkForUpdates.mockRejectedValueOnce(new Error('latest.yml ausente'))
    expect(await service.check()).toMatchObject({ available: true, mode: 'link' })
  })
})
