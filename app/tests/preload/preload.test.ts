import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '/caminho/arquivo.mp4') }
}))
vi.mock('electron', () => electron)

const { api } = await import('../../src/preload/index')
const { EVENTS, IPC, SEND } = await import('../../src/shared/ipc')

describe('preload', () => {
  beforeEach(() => {
    electron.ipcRenderer.invoke.mockReset()
  })

  it('expõe a API como window.transcriber', () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('transcriber', api)
  })

  it('cada método chama o canal certo com o argumento certo', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, data: 'r' })
    const calls: [() => Promise<unknown>, string, unknown][] = [
      [() => api.settings.get(), IPC.settingsGet, undefined],
      [() => api.settings.update({ theme: 'dark' }), IPC.settingsUpdate, { theme: 'dark' }],
      [() => api.queue.enqueue(['/a']), IPC.queueEnqueue, ['/a']],
      [() => api.queue.remove('id'), IPC.queueRemove, 'id'],
      [() => api.queue.cancel(), IPC.queueCancel, undefined],
      [() => api.queue.state(), IPC.queueState, undefined],
      [
        () => api.queue.retry('id', '/novo.mp3'),
        IPC.queueRetry,
        { id: 'id', sourcePath: '/novo.mp3' }
      ],
      [() => api.history.remove('id'), IPC.historyRemove, 'id'],
      [() => api.app.info(), IPC.appInfo, undefined],
      [() => api.history.list(), IPC.historyList, undefined],
      [() => api.history.get('id'), IPC.historyGet, 'id'],
      [() => api.history.clear(), IPC.historyClear, undefined],
      [() => api.history.stats(), IPC.historyStats, undefined],
      [() => api.models.status('ggml'), IPC.modelsStatus, 'ggml'],
      [
        () => api.models.install('small', 'ggml'),
        IPC.modelsInstall,
        { id: 'small', format: 'ggml' }
      ],
      [() => api.models.remove('small'), IPC.modelsRemove, { id: 'small', format: undefined }],
      [() => api.cuda.status(), IPC.cudaStatus, undefined],
      [() => api.cuda.install(), IPC.cudaInstall, undefined],
      [() => api.cuda.remove(), IPC.cudaRemove, undefined],
      [() => api.downloads.cancel({ kind: 'cuda' }), IPC.downloadCancel, { kind: 'cuda' }],
      [() => api.engine.selfTest(), IPC.engineSelfTest, undefined],
      [() => api.files.choose(), IPC.filesChoose, undefined],
      [
        () => api.files.save({ defaultName: 'a.txt', content: 'x' }),
        IPC.fileSave,
        { defaultName: 'a.txt', content: 'x' }
      ],
      [() => api.clipboard.write('t'), IPC.clipboardWrite, 't'],
      [() => api.system.info(), IPC.systemInfo, undefined],
      [() => api.system.openExternal('https://x'), IPC.openExternal, 'https://x'],
      [() => api.system.openDataFolder(), IPC.openDataFolder, undefined],
      [() => api.updates.check(), IPC.updatesCheck, undefined],
      [() => api.updates.install(), IPC.updatesInstall, undefined],
      [
        () => api.live.start({ tracks: ['voce'], test: true, title: 'T' }),
        IPC.liveStart,
        { tracks: ['voce'], test: true, title: 'T' }
      ],
      [() => api.live.stop(), IPC.liveStop, undefined],
      [() => api.live.pause(), IPC.livePause, undefined],
      [() => api.live.resume(), IPC.liveResume, undefined]
    ]
    for (const [run, channel, arg] of calls) {
      await expect(run()).resolves.toBe('r')
      expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, arg)
    }
    expect(calls).toHaveLength(Object.keys(IPC).length)
  })

  it('erro do main vira objeto simples (o contextBridge descartaria code/detail de um Error)', async () => {
    const error = { code: 'NO_AUDIO', message: 'sem áudio', detail: 'd' }
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: false, error })
    const rejection: unknown = await api.settings.get().catch((reason: unknown) => reason)
    expect(rejection).toEqual(error)
    expect(rejection).not.toBeInstanceOf(Error)
  })

  it('assinaturas de eventos repassam o payload e podem ser canceladas', () => {
    const subscriptions: [(cb: (p: unknown) => void) => () => void, string][] = [
      [(cb) => api.settings.onChanged(cb), EVENTS.settings],
      [(cb) => api.queue.onEvent(cb), EVENTS.queue],
      [(cb) => api.downloads.onEvent(cb), EVENTS.download],
      [(cb) => api.updates.onEvent(cb), EVENTS.update],
      [(cb) => api.live.onEvent(cb), EVENTS.live]
    ]
    for (const [subscribe, channel] of subscriptions) {
      const callback = vi.fn()
      const unsubscribe = subscribe(callback)
      const listener = electron.ipcRenderer.on.mock.lastCall![1] as (e: unknown, p: unknown) => void
      expect(electron.ipcRenderer.on.mock.lastCall![0]).toBe(channel)
      listener({}, { type: 'x' })
      expect(callback).toHaveBeenCalledWith({ type: 'x' })
      unsubscribe()
      expect(electron.ipcRenderer.removeListener).toHaveBeenLastCalledWith(channel, listener)
    }
  })

  it('blocos de áudio do ao vivo vão por send (sem resposta)', () => {
    const pcm = new Int16Array(4800)
    api.live.sendAudio('voce', 7, pcm)
    expect(electron.ipcRenderer.send).toHaveBeenCalledWith(SEND.liveAudio, {
      track: 'voce',
      seq: 7,
      pcm
    })
  })

  it('pathFor usa webUtils (File.path não existe mais no Electron)', () => {
    expect(api.files.pathFor({} as File)).toBe('/caminho/arquivo.mp4')
  })
})
