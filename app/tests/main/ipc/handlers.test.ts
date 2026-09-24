import { describe, expect, it, vi } from 'vitest'
import {
  registerIpcHandlers,
  sanitizeFileName,
  type IpcEventLike,
  type Services
} from '../../../src/main/ipc/handlers'
import { AppError } from '../../../src/shared/errors'
import { IPC, SEND } from '../../../src/shared/ipc'
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/settings'

const JOB = '11111111-1111-4111-8111-111111111111'
const APP_FRAME = { processId: 1, routingId: 1 }
const TRUSTED: IpcEventLike = { sender: 'app', senderFrame: APP_FRAME }

function setup(settingsOverride: Partial<Settings> = {}) {
  const handlers = new Map<string, (event: IpcEventLike, arg?: unknown) => Promise<unknown>>()
  let settings: Settings = { ...DEFAULT_SETTINGS, model: 'medium', ...settingsOverride }
  const services = {
    settings: {
      get: () => settings,
      update: vi.fn((patch: Partial<Settings>) => {
        settings = { ...settings, ...patch }
        return Promise.resolve(settings)
      })
    },
    queue: {
      enqueue: vi.fn(() => Promise.resolve({ accepted: [], rejected: [] })),
      remove: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
      state: vi.fn(() => ({ current: null, pending: [] })),
      isIdle: vi.fn(() => true),
      retry: vi.fn(() => Promise.resolve({ id: JOB, status: 'queued' })),
      removeEntry: vi.fn(() => Promise.resolve()),
      setVersion: vi.fn(() => Promise.resolve({ id: JOB, activeVersion: 'live' })),
      selfTest: vi.fn(() => Promise.resolve())
    },
    history: {
      list: vi.fn(() => Promise.resolve({ entries: [], corrupted: [] })),
      get: vi.fn(() =>
        Promise.resolve({ id: JOB, mediaKind: 'video', sourcePath: '/nao/existe.mp4' })
      ),
      readActive: vi.fn(() => Promise.resolve([{ inicio: 0, fim: 1, texto: 'a' }])),
      hasRedo: vi.fn(() => Promise.resolve(false)),
      clear: vi.fn(() => Promise.resolve({ count: 2, bytes: 10 })),
      stats: vi.fn(() => Promise.resolve({ count: 2, bytes: 10 }))
    },
    installer: {
      installedModels: vi.fn(() => Promise.resolve(['medium'])),
      partialModels: vi.fn(() => Promise.resolve(['large-v3'])),
      modelSizes: vi.fn(() => ({ small: 1, medium: 2, 'large-v3-turbo': 3, 'large-v3': 4 })),
      installModel: vi.fn(() => Promise.resolve()),
      removeModel: vi.fn(() => Promise.resolve()),
      cudaSupported: vi.fn(() => true),
      isCudaInstalled: vi.fn(() => Promise.resolve(false)),
      cudaSize: vi.fn(() => 99),
      installCuda: vi.fn(() => Promise.resolve()),
      removeCuda: vi.fn(() => Promise.resolve()),
      cancel: vi.fn()
    },
    dialogs: {
      chooseFiles: vi.fn(() => Promise.resolve(['/a.mp4'])),
      saveText: vi.fn(() => Promise.resolve(true))
    },
    clipboard: { writeText: vi.fn() },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
      openPath: vi.fn(() => Promise.resolve(''))
    },
    systemInfo: vi.fn(() => Promise.resolve({ platform: 'linux' })),
    checkUpdates: vi.fn(() => Promise.resolve(null)),
    installUpdate: vi.fn(),
    dataDir: '/dados',
    appInfo: vi.fn(() => ({ version: '0.1.0', platform: 'linux', settingsRecovered: false })),
    externalUrls: new Set(['https://github.com/facebook/react']),
    liveCapabilities: vi.fn(() => ({ systemAudio: 'monitor' })),
    monitorVolume: {
      read: vi.fn(() => Promise.resolve({ sink: 'Fone', percent: 8, muted: false })),
      set: vi.fn((percent: number) => Promise.resolve({ sink: 'Fone', percent, muted: false }))
    },
    live: {
      start: vi.fn(() => Promise.resolve({ sessionId: 's', itemId: null })),
      stop: vi.fn(() => Promise.resolve(null)),
      pause: vi.fn(),
      resume: vi.fn(),
      audio: vi.fn()
    }
  }
  const senders = new Map<string, (event: IpcEventLike, arg?: unknown) => void>()
  registerIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, (event, arg) => Promise.resolve(listener(event, arg)))
      },
      on: (channel, listener) => {
        senders.set(channel, listener)
      }
    },
    services as unknown as Services,
    (event) => event.sender === 'app' && event.senderFrame === APP_FRAME
  )
  const call = (channel: string, arg?: unknown, event: IpcEventLike = TRUSTED) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`canal não registrado: ${channel}`)
    return handler(event, arg)
  }
  const send = (channel: string, arg: unknown, event: IpcEventLike = TRUSTED) => {
    senders.get(channel)?.(event, arg)
  }
  return { call, send, services, handlers }
}

const ok = (data: unknown) => ({ ok: true, data })
const fail = (code: string): unknown =>
  expect.objectContaining({ ok: false, error: expect.objectContaining({ code }) as unknown })

describe('registerIpcHandlers', () => {
  it('registra todos os canais', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC).sort())
  })

  it('rejeita remetente não confiável e parâmetros inválidos', async () => {
    const { call, services } = setup()
    expect(
      await call(IPC.settingsGet, undefined, { sender: 'outra', senderFrame: APP_FRAME })
    ).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.settingsGet, undefined, { sender: 'app', senderFrame: null })).toEqual(
      fail('INVALID_REQUEST')
    )
    expect(await call(IPC.queueRemove, '../../etc')).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.queueEnqueue, [])).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.modelsInstall, { id: 'gigante' })).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.modelsInstall, { id: 'small', format: 'onnx' })).toEqual(
      fail('INVALID_REQUEST')
    )
    expect(await call(IPC.queueCancel, 'extra')).toEqual(fail('INVALID_REQUEST'))
    expect(services.queue.remove).not.toHaveBeenCalled()
  })

  it('erros dos serviços voltam como { ok: false }', async () => {
    const { call, services } = setup()
    services.queue.enqueue.mockRejectedValueOnce(new AppError('MODEL_NOT_LOADED', 'x'))
    expect(await call(IPC.queueEnqueue, ['/a.mp4'])).toEqual(fail('MODEL_NOT_LOADED'))
    services.queue.selfTest.mockRejectedValueOnce(new Error('boom'))
    expect(await call(IPC.engineSelfTest)).toEqual(fail('INTERNAL'))
  })

  it('configurações', async () => {
    const { call, services } = setup()
    expect(await call(IPC.settingsGet)).toMatchObject({ ok: true, data: { model: 'medium' } })
    await call(IPC.settingsUpdate, { theme: 'dark' })
    expect(services.settings.update).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('fila', async () => {
    const { call, services } = setup()
    expect(await call(IPC.queueEnqueue, ['/a.mp4'])).toEqual(ok({ accepted: [], rejected: [] }))
    expect(await call(IPC.queueRemove, JOB)).toEqual(ok(null))
    expect(await call(IPC.queueCancel)).toEqual(ok(null))
    expect(await call(IPC.queueState)).toEqual(ok({ current: null, pending: [] }))
    expect(services.queue.remove).toHaveBeenCalledWith(JOB)
    expect(services.queue.cancel).toHaveBeenCalled()
  })

  it('repetir, excluir do histórico e informações do app', async () => {
    const { call, services } = setup()
    expect(await call(IPC.queueRetry, { id: JOB })).toEqual(ok({ id: JOB, status: 'queued' }))
    expect(services.queue.retry).toHaveBeenLastCalledWith(JOB, undefined)
    await call(IPC.queueRetry, { id: JOB, sourcePath: '/novo/a.mp3' })
    expect(services.queue.retry).toHaveBeenLastCalledWith(JOB, '/novo/a.mp3')
    expect(await call(IPC.queueRetry, { id: '../x' })).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.queueRetry, { id: JOB, sourcePath: '' })).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.historyRemove, JOB)).toEqual(ok(null))
    expect(services.queue.removeEntry).toHaveBeenCalledWith(JOB)
    expect(await call(IPC.appInfo)).toEqual(
      ok({ version: '0.1.0', platform: 'linux', settingsRecovered: false })
    )
  })

  it('histórico: detalhe informa se o vídeo original ainda existe', async () => {
    const { call } = setup()
    expect(await call(IPC.historyList)).toEqual(ok({ entries: [], corrupted: [] }))
    expect(await call(IPC.historyGet, JOB)).toEqual(
      ok({
        meta: { id: JOB, mediaKind: 'video', sourcePath: '/nao/existe.mp4' },
        transcript: [{ inicio: 0, fim: 1, texto: 'a' }],
        videoAvailable: false,
        hasRedo: false
      })
    )
    expect(await call(IPC.historyStats)).toEqual(ok({ count: 2, bytes: 10 }))
  })

  it('histórico: escolher a versão de um item ao vivo', async () => {
    const { call, services } = setup()
    expect(await call(IPC.historySetVersion, { id: JOB, version: 'live' })).toEqual(
      ok({ id: JOB, activeVersion: 'live' })
    )
    expect(services.queue.setVersion).toHaveBeenCalledWith(JOB, 'live')
    expect(await call(IPC.historySetVersion, { id: JOB, version: 'outra' })).toEqual(
      fail('INVALID_REQUEST')
    )
  })

  it('limpar histórico só com a fila ociosa', async () => {
    const { call, services } = setup()
    expect(await call(IPC.historyClear)).toEqual(ok({ count: 2, bytes: 10 }))
    services.queue.isIdle.mockReturnValue(false)
    expect(await call(IPC.historyClear)).toEqual(fail('INVALID_REQUEST'))
  })

  it('modelos: status, instalar e remover (menos o que está em uso)', async () => {
    const { call, services } = setup()
    expect(await call(IPC.modelsStatus)).toEqual(
      ok({
        installed: ['medium'],
        partial: ['large-v3'],
        sizes: { small: 1, medium: 2, 'large-v3-turbo': 3, 'large-v3': 4 }
      })
    )
    await call(IPC.modelsInstall, { id: 'small' })
    expect(services.installer.installModel).toHaveBeenCalledWith('small', 'ct2')
    expect(await call(IPC.modelsRemove, { id: 'medium' })).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.modelsRemove, { id: 'small' })).toEqual(ok(null))
    // o medium em uso é o do formato ct2 (CPU); o GGML dele pode sair
    expect(await call(IPC.modelsRemove, { id: 'medium', format: 'ggml' })).toEqual(ok(null))
    expect(services.installer.removeModel).toHaveBeenLastCalledWith('medium', 'ggml')
    await call(IPC.modelsInstall, { id: 'large-v3', format: 'ggml' })
    expect(services.installer.installModel).toHaveBeenLastCalledWith('large-v3', 'ggml')
    await call(IPC.modelsStatus, 'ggml')
    expect(services.installer.installedModels).toHaveBeenLastCalledWith('ggml')
    expect(services.installer.modelSizes).toHaveBeenLastCalledWith('ggml')
  })

  it('CUDA: exige aceite dos termos; remover volta para CPU', async () => {
    const { call, services } = setup({ device: 'cuda' })
    expect(await call(IPC.cudaStatus)).toEqual(
      ok({ supported: true, installed: false, sizeBytes: 99 })
    )
    expect(await call(IPC.cudaInstall)).toEqual(fail('INVALID_REQUEST'))
    await call(IPC.settingsUpdate, { nvidiaTermsAccepted: true })
    expect(await call(IPC.cudaInstall)).toEqual(ok(null))
    expect(await call(IPC.cudaRemove)).toEqual(ok(null))
    expect(services.settings.update).toHaveBeenLastCalledWith({ device: 'cpu' })
    expect(services.installer.removeCuda).toHaveBeenCalled()
  })

  it('remover CUDA em CPU não mexe nas configurações', async () => {
    const { call, services } = setup()
    await call(IPC.cudaRemove)
    expect(services.settings.update).not.toHaveBeenCalled()
  })

  it('downloads e motor', async () => {
    const { call, services } = setup()
    expect(await call(IPC.downloadCancel, { kind: 'cuda' })).toEqual(ok(null))
    expect(await call(IPC.downloadCancel, { kind: 'model', id: 'small' })).toEqual(ok(null))
    expect(await call(IPC.downloadCancel, { kind: 'model', id: 'small', format: 'ggml' })).toEqual(
      ok(null)
    )
    expect(services.installer.cancel).toHaveBeenCalledWith({ kind: 'model', id: 'small' })
    expect(await call(IPC.engineSelfTest)).toEqual(ok(null))
  })

  it('arquivos, área de transferência e sistema', async () => {
    const { call, services } = setup()
    expect(await call(IPC.filesChoose)).toEqual(ok(['/a.mp4']))
    expect(
      await call(IPC.fileSave, { defaultName: 'transcricao-a/b:c.txt', content: 'x' })
    ).toEqual(ok(true))
    expect(services.dialogs.saveText).toHaveBeenCalledWith('transcricao-a_b_c.txt', 'x')
    expect(await call(IPC.clipboardWrite, 'texto')).toEqual(ok(null))
    expect(services.clipboard.writeText).toHaveBeenCalledWith('texto')
    expect(await call(IPC.systemInfo)).toEqual(ok({ platform: 'linux' }))
    expect(await call(IPC.openDataFolder)).toEqual(ok(null))
    expect(services.shell.openPath).toHaveBeenCalledWith('/dados')
  })

  it('openExternal só com URL permitida', async () => {
    const { call, services } = setup()
    expect(await call(IPC.openExternal, 'https://github.com/eldevanjr')).toEqual(ok(null))
    expect(await call(IPC.openExternal, 'https://evil.example')).toEqual(fail('INVALID_REQUEST'))
    expect(await call(IPC.openExternal, 'https://github.com/facebook/react')).toEqual(ok(null))
    expect(services.shell.openExternal).toHaveBeenCalledTimes(2)
  })

  it('verificação de versão respeita a configuração', async () => {
    const { call, services } = setup({ checkUpdates: false })
    expect(await call(IPC.updatesCheck)).toEqual(ok(null))
    expect(services.checkUpdates).not.toHaveBeenCalled()
    await call(IPC.settingsUpdate, { checkUpdates: true })
    await call(IPC.updatesCheck)
    expect(services.checkUpdates).toHaveBeenCalled()
  })

  it('instalar a atualização baixada reinicia pelo electron-updater', async () => {
    const { call, services } = setup()
    expect(await call(IPC.updatesInstall)).toEqual(ok(null))
    expect(services.installUpdate).toHaveBeenCalled()
  })
})

describe('sanitizeFileName', () => {
  it.each([
    ['transcricao-aula 03.txt', 'transcricao-aula 03.txt'],
    ['a/b\\c:d*e?f"g<h>i|j.txt', 'a_b_c_d_e_f_g_h_i_j.txt'],
    ['   ', 'transcricao.txt'],
    ['x'.repeat(300), 'x'.repeat(200)]
  ])('%s → %s', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected)
  })
})

describe('IPC do ao vivo', () => {
  it('start valida as faixas, o modo teste e o título', async () => {
    const { call, services } = setup()
    const opts = { tracks: ['voce', 'outros'], test: false, title: 'Reunião 23/09 10:00' }
    expect(await call(IPC.liveStart, opts)).toEqual(ok({ sessionId: 's', itemId: null }))
    expect(services.live.start).toHaveBeenCalledWith(opts)
    for (const bad of [
      { ...opts, tracks: [] },
      { ...opts, tracks: ['voce', 'voce'] },
      { ...opts, tracks: ['alguem'] },
      { ...opts, title: 'x'.repeat(201) },
      { ...opts, test: 'sim' }
    ]) {
      expect(await call(IPC.liveStart, bad)).toEqual(fail('INVALID_REQUEST'))
    }
  })

  it('stop, pausa e retomar; capacidades do sistema', async () => {
    const { call, services } = setup()
    expect(await call(IPC.liveCapabilities)).toEqual(ok({ systemAudio: 'monitor' }))
    expect(await call(IPC.liveStop)).toEqual(ok(null))
    expect(await call(IPC.livePause)).toEqual(ok(null))
    expect(await call(IPC.liveResume)).toEqual(ok(null))
    expect(services.live.stop).toHaveBeenCalled()
    expect(services.live.pause).toHaveBeenCalled()
    expect(services.live.resume).toHaveBeenCalled()
  })

  it('volume de captura do áudio do computador: lê e ajusta só com 0–100 inteiro', async () => {
    const { call, services } = setup()
    expect(await call(IPC.liveMonitorVolume)).toEqual(
      ok({ sink: 'Fone', percent: 8, muted: false })
    )
    expect(await call(IPC.liveSetMonitorVolume, 100)).toEqual(
      ok({ sink: 'Fone', percent: 100, muted: false })
    )
    for (const bad of [-1, 101, 50.5, '100', null]) {
      expect(await call(IPC.liveSetMonitorVolume, bad)).toEqual(fail('INVALID_REQUEST'))
    }
    expect(services.monitorVolume.set).toHaveBeenCalledTimes(1)
  })

  it('blocos de áudio: só do app e só no formato certo (100 ms a 48 kHz)', () => {
    const { send, services } = setup()
    const pcm = new Int16Array(4800).fill(7)
    send(SEND.liveAudio, { track: 'voce', seq: 3, pcm })
    expect(services.live.audio).toHaveBeenCalledWith('voce', 3, pcm)
    send(SEND.liveAudio, { track: 'voce', seq: 4, pcm }, { sender: 'outro', senderFrame: null })
    send(SEND.liveAudio, { track: 'voce', seq: 5, pcm: new Int16Array(10) })
    send(SEND.liveAudio, { track: 'alguem', seq: 6, pcm })
    send(SEND.liveAudio, { track: 'voce', seq: -1, pcm })
    expect(services.live.audio).toHaveBeenCalledTimes(1)
  })
})
