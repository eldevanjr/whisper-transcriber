import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { release, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell
} from 'electron'
import log from 'electron-log/main'
import manifestJson from '../../resources/downloads-manifest.json'
import licensesJson from '../../resources/third-party-licenses.json'
import { licenseUrls } from '../shared/app-info'
import { EVENTS } from '../shared/ipc'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../shared/media'
import { readDevOverrides } from './dev-overrides'
import { Installer } from './downloads/installer'
import { parseManifest } from './downloads/manifest'
import { HistoryStore } from './history/store'
import { registerIpcHandlers, type Services } from './ipc/handlers'
import { LiveService } from './live/session'
import {
  allowPermission,
  displayMediaHandler,
  MAC_LOOPBACK_FEATURE,
  systemAudioSupport
} from './live/system-audio'
import { createMediaHandler, MEDIA_SCHEME } from './media-protocol'
import { appPaths, modelDir } from './paths'
import { TranscriptionQueue } from './queue/queue'
import { applyCsp, isAllowedExternalUrl, isAllowedNavigation, isTrustedSender } from './security'
import { SettingsStore } from './settings/store'
import { applyTheme } from './theme'
import { getSystemInfo } from './system/info'
import electronUpdater from 'electron-updater'
import { createUpdater } from './updates'
import windowIcon from '../../resources/icon.png?asset'
import { createMainWindow } from './window'
import { resolveWorkerCommand, workerEnv } from './worker/locate'
import { WorkerSupervisor, type Logger } from './worker/supervisor'

const execFileAsync = promisify(execFile)

if (process.env.WT_USER_DATA) app.setPath('userData', process.env.WT_USER_DATA)

// macOS 14.2+: áudio do sistema no ao vivo pela captura de tela (precisa ligar antes do ready).
if (process.platform === 'darwin')
  app.commandLine.appendSwitch('enable-features', MAC_LOOPBACK_FEATURE)

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }
])

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()
  const paths = appPaths(app.getPath('userData'))
  log.transports.file.resolvePathFn = () => join(paths.logs, 'main.log')
  log.transports.file.maxSize = 5 * 1024 * 1024
  const logger: Logger = {
    info: (message) => {
      log.info(message)
    },
    warn: (message) => {
      log.warn(message)
    },
    error: (message) => {
      log.error(message)
    }
  }

  const settings = await SettingsStore.open(paths)
  if (settings.recovered)
    logger.warn('settings.json inválido: padrão restaurado (backup em settings.bak.json)')
  const history = new HistoryStore(paths.history)
  let window: BrowserWindow | null = null
  const send = (channel: string, payload: unknown): void => {
    window?.webContents.send(channel, payload)
  }

  const overrides = readDevOverrides(process.env, app.isPackaged)
  const manifest = parseManifest(
    overrides.manifestPath
      ? (JSON.parse(await readFile(overrides.manifestPath, 'utf8')) as unknown)
      : manifestJson
  )
  const worker = new WorkerSupervisor({
    spawn: (command, args, options) =>
      spawn(command, [...args], { ...options, stdio: 'pipe', windowsHide: true }),
    commandLine:
      overrides.workerCommand ??
      resolveWorkerCommand({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform
      }),
    envFor: (device) =>
      workerEnv(process.env, { platform: process.platform, device, cudaDir: paths.cuda }),
    expectedVersion: app.getVersion(),
    logger,
    onLiveEvent: (event) => {
      live.onWorkerEvent(event)
    }
  })
  const installer = new Installer({
    manifest,
    paths,
    fetch: (url, init) => fetch(url, init),
    emit: (event) => {
      send(EVENTS.download, event)
    },
    platform: process.platform,
    arch: process.arch
  })
  const updater = createUpdater({
    platform: process.platform,
    env: process.env,
    version: app.getVersion(),
    fetch: (url, init) => fetch(url, init),
    autoUpdater: () => electronUpdater.autoUpdater,
    emit: (event) => {
      send(EVENTS.update, event)
    }
  })
  const queue = new TranscriptionQueue({
    history,
    settings,
    worker,
    modelDir: (id, format) => modelDir(paths, id, format),
    cudaLibDir: paths.cuda,
    emit: (event) => {
      send(EVENTS.queue, event)
    },
    logger,
    hasModel: (id, format) => installer.isModelInstalled(id, format)
  })
  const live = new LiveService({
    worker,
    queue,
    history,
    settings,
    emit: (event) => {
      send(EVENTS.live, event)
    },
    onItem: (meta) => {
      send(EVENTS.queue, { type: 'job', meta })
    },
    logger
  })

  protocol.handle(MEDIA_SCHEME, createMediaHandler({ history }))
  applyCsp(session.defaultSession)
  // Ao vivo: só microfone (áudio) e a captura usada para o áudio do sistema; o resto é recusado.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(allowPermission(permission, { mediaTypes }))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    allowPermission(permission, details)
  )
  const onDisplayMedia = displayMediaHandler((options) => desktopCapturer.getSources(options))
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      void onDisplayMedia(request, callback)
    },
    { useSystemPicker: false }
  )

  const isDev = !app.isPackaged
  const rendererUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined
  const indexHtml = join(__dirname, '../renderer/index.html')

  const services: Services = {
    settings,
    queue,
    history,
    installer,
    dialogs: {
      chooseFiles: async () => {
        const result = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Vídeos e áudios', extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] }
          ]
        })
        return result.canceled ? [] : result.filePaths
      },
      saveText: async (defaultName, content) => {
        const result = await dialog.showSaveDialog({ defaultPath: defaultName })
        if (result.canceled || !result.filePath) return false
        await writeFile(result.filePath, content, 'utf8')
        return true
      }
    },
    clipboard: {
      writeText: (text) => clipboard.writeText(text)
    },
    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (path) => shell.openPath(path)
    },
    systemInfo: () =>
      getSystemInfo({
        platform: process.platform,
        arch: process.arch,
        totalmem,
        execFile: (file, args, options) => execFileAsync(file, [...args], options)
      }),
    checkUpdates: () => updater.check(),
    installUpdate: () => {
      updater.install()
    },
    dataDir: paths.root,
    externalUrls: licenseUrls(licensesJson),
    live,
    liveCapabilities: () => ({ systemAudio: systemAudioSupport(process.platform, release()) }),
    appInfo: () => ({
      version: app.getVersion(),
      platform: process.platform,
      settingsRecovered: settings.recovered
    })
  }
  registerIpcHandlers(ipcMain, services, (event) =>
    isTrustedSender(event, window?.webContents ?? null)
  )
  applyTheme(nativeTheme, settings.get().theme)
  settings.onChange((next) => {
    applyTheme(nativeTheme, next.theme)
    send(EVENTS.settings, next)
  })

  window = createMainWindow({
    BrowserWindowCtor: BrowserWindow,
    preloadPath: join(__dirname, '../preload/index.js'),
    isDev,
    dark: nativeTheme.shouldUseDarkColors,
    ...(process.platform === 'linux' ? { icon: windowIcon } : {}),
    isAllowedNavigation: (url) => isAllowedNavigation(url, rendererUrl),
    isAllowedExternal: (url) => isAllowedExternalUrl(url),
    openExternal: (url) => {
      void shell.openExternal(url)
    }
  })
  window.on('closed', () => {
    window = null
  })
  await (rendererUrl ? window.loadURL(rendererUrl) : window.loadFile(indexHtml))
  await queue.restore()
  // Sessões ao vivo que caíram com o app: a gravação vira m4a e o item fica "Interrompida".
  live.recover().catch((error: unknown) => {
    logger.error(`[ao vivo] recuperação falhou: ${String(error)}`)
  })
  logger.info(`app pronto (versão ${app.getVersion()})`)

  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  app.on('before-quit', () => {
    queue.shutdown()
    worker.dispose()
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
}

main().catch((error: unknown) => {
  log.error(error)
  app.quit()
})
