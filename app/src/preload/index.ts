// Com sandbox: true, este arquivo só pode importar 'electron' e módulos locais sem dependências.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENTS, IPC, SEND, type IpcResult, type TranscriberApi } from '../shared/ipc'

async function invoke<T>(channel: string, arg?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, arg)) as IpcResult<T>
  if (result.ok) return result.data
  // Objeto simples de propósito: o contextBridge copia só message/stack de um Error e
  // descartaria code/detail — a interface ficaria sem saber qual erro traduzir.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw result.error
}

function subscribe(channel: string, callback: (payload: never) => void): () => void {
  // O main só envia neste canal o tipo que a API declara para ele.
  const listener = (_event: unknown, payload: unknown): void => {
    callback(payload as never)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export const api: TranscriberApi = {
  settings: {
    get: () => invoke(IPC.settingsGet),
    update: (patch) => invoke(IPC.settingsUpdate, patch),
    onChanged: (callback) => subscribe(EVENTS.settings, callback)
  },
  queue: {
    enqueue: (paths) => invoke(IPC.queueEnqueue, paths),
    remove: (id) => invoke(IPC.queueRemove, id),
    cancel: () => invoke(IPC.queueCancel),
    state: () => invoke(IPC.queueState),
    retry: (id, sourcePath) => invoke(IPC.queueRetry, { id, sourcePath }),
    onEvent: (callback) => subscribe(EVENTS.queue, callback)
  },
  history: {
    list: () => invoke(IPC.historyList),
    get: (id) => invoke(IPC.historyGet, id),
    clear: () => invoke(IPC.historyClear),
    stats: () => invoke(IPC.historyStats),
    remove: (id) => invoke(IPC.historyRemove, id),
    setVersion: (id, version) => invoke(IPC.historySetVersion, { id, version })
  },
  models: {
    status: (format) => invoke(IPC.modelsStatus, format),
    install: (id, format) => invoke(IPC.modelsInstall, { id, format }),
    remove: (id, format) => invoke(IPC.modelsRemove, { id, format })
  },
  cuda: {
    status: () => invoke(IPC.cudaStatus),
    install: () => invoke(IPC.cudaInstall),
    remove: () => invoke(IPC.cudaRemove)
  },
  downloads: {
    cancel: (target) => invoke(IPC.downloadCancel, target),
    onEvent: (callback) => subscribe(EVENTS.download, callback)
  },
  engine: { selfTest: () => invoke(IPC.engineSelfTest) },
  files: {
    choose: () => invoke(IPC.filesChoose),
    pathFor: (file) => webUtils.getPathForFile(file),
    save: (input) => invoke(IPC.fileSave, input)
  },
  clipboard: { write: (text) => invoke(IPC.clipboardWrite, text) },
  system: {
    info: () => invoke(IPC.systemInfo),
    openExternal: (url) => invoke(IPC.openExternal, url),
    openDataFolder: () => invoke(IPC.openDataFolder)
  },
  updates: {
    check: () => invoke(IPC.updatesCheck),
    install: () => invoke(IPC.updatesInstall),
    onEvent: (callback) => subscribe(EVENTS.update, callback)
  },
  app: { info: () => invoke(IPC.appInfo) },
  live: {
    capabilities: () => invoke(IPC.liveCapabilities),
    monitorVolume: () => invoke(IPC.liveMonitorVolume),
    setMonitorVolume: (percent) => invoke(IPC.liveSetMonitorVolume, percent),
    start: (input) => invoke(IPC.liveStart, input),
    stop: () => invoke(IPC.liveStop),
    pause: () => invoke(IPC.livePause),
    resume: () => invoke(IPC.liveResume),
    sendAudio: (track, seq, pcm) => {
      ipcRenderer.send(SEND.liveAudio, { track, seq, pcm })
    },
    onEvent: (callback) => subscribe(EVENTS.live, callback)
  },
  mcpStatus: () => invoke(IPC.mcpStatus),
  mcpConnect: (id) => invoke(IPC.mcpConnect, id),
  mcpDisconnect: (id) => invoke(IPC.mcpDisconnect, id),
  mcpTest: () => invoke(IPC.mcpTest),
  mcpActivity: () => invoke(IPC.mcpActivity)
}

contextBridge.exposeInMainWorld('transcriber', api)
