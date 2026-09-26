import { execFile, spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { release, totalmem } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  session,
  shell,
  Tray
} from 'electron'
import log from 'electron-log/main'
import manifestJson from '../../resources/downloads-manifest.json'
import licensesJson from '../../resources/third-party-licenses.json'
import { APP_ID, licenseUrls } from '../shared/app-info'
import { AppError } from '../shared/errors'
import { EVENTS, type NavigateTarget } from '../shared/ipc'
import { resolveLanguage } from '../shared/language'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../shared/media'
import type { ClientStatus, McpClientId } from '../shared/mcp'
import { applyAutostart, openedHidden } from './background/autostart'
import { applyBadge } from './background/badge'
import { BackgroundController } from './background/controller'
import { FlagsStore } from './background/flags'
import { OVERLAY_ICON, trayIconDir } from './background/icons'
import { Notifier } from './background/notify'
import { Shortcuts } from './background/shortcut'
import { createTranslate } from './background/texts'
import { TrayView } from './background/tray'
import { readDevOverrides } from './dev-overrides'
import { Installer } from './downloads/installer'
import { parseManifest } from './downloads/manifest'
import { HistoryStore } from './history/store'
import { registerIpcHandlers, type Services } from './ipc/handlers'
import { createMonitorVolume } from './live/monitor-volume'
import { LiveService } from './live/session'
import {
  allowPermission,
  displayMediaHandler,
  MAC_LOOPBACK_FEATURE,
  systemAudioSupport
} from './live/system-audio'
import { createMediaHandler, MEDIA_SCHEME } from './media-protocol'
import { isMcpMode, runMcp } from './mcp/entry'
import { ActivityTracker } from './mcp/activity-tracker'
import { ActivityLog } from './mcp/activity'
import { startBridgeServer } from './mcp/bridge-server'
import { createCli } from './mcp/clients/cli'
import { createConnectors, listClients, type ConnectorDeps } from './mcp/clients/registry'
import { launcherStatus, launcherTarget, writeLauncher } from './mcp/launcher'
import { runSelfTest } from './mcp/self-test'
import { buildMcpStatus } from './mcp/status'
import { appPaths, modelDir } from './paths'
import { TranscriptionQueue } from './queue/queue'
import { applyCsp, isAllowedExternalUrl, isAllowedNavigation, isTrustedSender } from './security'
import { SettingsStore } from './settings/store'
import { applyTheme } from './theme'
import { getSystemInfo } from './system/info'
import electronUpdater from 'electron-updater'
import { createUpdater } from './updates'
import windowIcon from '../../resources/icon.png?asset'
import { integrateAppImage } from './linux-integration'
import { createMainWindow, isWindowInView, keepInTray } from './window'
import { resolveWorkerCommand, workerEnv } from './worker/locate'
import { WorkerSupervisor, type Logger } from './worker/supervisor'

const execFileAsync = promisify(execFile)

if (process.env.WT_USER_DATA) app.setPath('userData', process.env.WT_USER_DATA)

// macOS 14.2+: áudio do sistema no ao vivo pela captura de tela (precisa ligar antes do ready).
if (process.platform === 'darwin')
  app.commandLine.appendSwitch('enable-features', MAC_LOOPBACK_FEATURE)

// Wayland: o atalho global vai pelo portal do sistema (o GNOME pede confirmação na 1ª vez).
if (process.platform === 'linux')
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

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
  let quitting = false
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

  // O lançador que as IAs chamam é regravado a cada abertura (spec §6), sem bloquear o app.
  void writeLauncher(
    paths,
    launcherTarget({
      platform: process.platform,
      execPath: process.execPath,
      env: process.env,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath()
    }),
    process.platform
  ).catch((error: unknown) => {
    logger.error(`[mcp] não foi possível gravar o lançador: ${String(error)}`)
  })

  const settings = await SettingsStore.open(paths)
  if (settings.recovered)
    logger.warn('settings.json inválido: padrão restaurado (backup em settings.bak.json)')
  const history = new HistoryStore(paths.history)
  // Retrato do que o app está fazendo, servido pela ponte do MCP (spec §7.4).
  const tracker = new ActivityTracker()
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
  // Criado depois (precisa da fila e do ao vivo); os eventos chegam só com o app rodando.
  let background: BackgroundController | null = null
  const queue = new TranscriptionQueue({
    history,
    settings,
    worker,
    modelDir: (id, format) => modelDir(paths, id, format),
    cudaLibDir: paths.cuda,
    emit: (event) => {
      tracker.onQueueEvent(event)
      send(EVENTS.queue, event)
      background?.onQueueEvent(event)
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
      tracker.onLive(event)
      send(EVENTS.live, event)
      background?.onLiveEvent(event)
    },
    onItem: (meta) => {
      tracker.onQueueEvent({ type: 'job', meta })
      send(EVENTS.queue, { type: 'job', meta })
      background?.onItem(meta)
    },
    logger
  })
  // Ponte local com o processo --mcp (spec §7): só socket/pipe, nenhuma porta de rede.
  const bridgeServer = await startBridgeServer({
    paths,
    tracker,
    queue,
    settings,
    platform: process.platform,
    version: app.getVersion(),
    // O nome do named pipe (Windows) leva o hash do usuário: sem o env, todos os usuários da
    // máquina disputariam o mesmo pipe (spec §7.1).
    env: process.env
  }).catch((error: unknown) => {
    logger.error(`[mcp] não foi possível subir a ponte: ${String(error)}`)
    return { address: '', close: () => Promise.resolve() }
  })
  const mcpHome = app.getPath('home')
  const connectorDeps: ConnectorDeps = {
    platform: process.platform,
    home: mcpHome,
    env: process.env,
    launcherPath: paths.mcpLauncher,
    cli: createCli({ platform: process.platform, home: mcpHome, env: process.env })
  }
  const activityLog = new ActivityLog(paths.mcpActivity)

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

  const setupBackground = async (): Promise<{
    controller: BackgroundController
    shortcuts: Shortcuts
    tray: Tray
    showWindow: (target: NavigateTarget) => void
  }> => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID) // notificações do Windows
    const iconDir = trayIconDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    const translate = () =>
      createTranslate(resolveLanguage(settings.get().uiLanguage, app.getLocale()))
    const showWindow = (target: NavigateTarget): void => {
      window?.show()
      window?.focus()
      if (target.kind !== 'window') send(EVENTS.backgroundNavigate, target)
    }
    const notifier = new Notifier({
      Notification,
      open: showWindow,
      ...(process.platform === 'linux' ? { icon: windowIcon } : {}),
      logger
    })
    const flags = await FlagsStore.open(paths.state)
    const shortcuts = new Shortcuts({
      globalShortcut,
      onPress: () => background?.toggle(),
      wayland: process.env.XDG_SESSION_TYPE === 'wayland',
      logger
    })
    const tray = new Tray(join(iconDir, 'tray-normal.png'))
    const view = new TrayView({
      tray,
      buildMenu: (template) => Menu.buildFromTemplate(template),
      iconDir,
      platform: process.platform,
      onAction: (action) => {
        if (action === 'toggle') background?.toggle()
        else if (action === 'pause') background?.pause()
        else if (action === 'resume') background?.resume()
        else if (action === 'quit') void background?.quit()
        else showWindow({ kind: 'window' }) // open e setup
      }
    })
    background = new BackgroundController({
      live,
      queueIdle: () => queue.isIdle(),
      ready: () => settings.get().model !== null,
      command: (command) => {
        send(EVENTS.backgroundCommand, command)
      },
      view,
      notify: (title, body, target) => {
        notifier.show(title, body, target)
      },
      badge: (active, description) => {
        applyBadge(active, description, {
          platform: process.platform,
          setOverlay: (icon, text) => {
            window?.setOverlayIcon(icon ? nativeImage.createFromPath(icon) : null, text)
          },
          setDockBadge: (text) => {
            app.dock?.setBadge(text)
          },
          overlayIcon: join(iconDir, OVERLAY_ICON)
        })
      },
      shortcut: () => shortcuts.active,
      windowFocused: () => isWindowInView(window),
      notifyAi: () => settings.get().tray.notifyAi,
      translate,
      flags,
      quit: () => {
        quitting = true
        app.quit()
      },
      platform: process.platform,
      logger
    })
    const controller = background
    if (process.env.WT_E2E_HOOKS === '1') {
      ;(globalThis as { __wtBackground?: BackgroundController }).__wtBackground = controller
    }
    return { controller, shortcuts, tray, showWindow }
  }
  const { controller, shortcuts, tray, showWindow } = await setupBackground()

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
    clearActivity: () => rm(paths.mcpActivity, { force: true }),
    externalUrls: licenseUrls(licensesJson),
    live,
    mcp: {
      status: async () =>
        buildMcpStatus({
          launcher: launcherStatus(),
          launcherPath: paths.mcpLauncher,
          bridgeOk: bridgeServer.address !== '',
          clients: await listClients({ ...connectorDeps, activity: activityLog })
        }),
      connect: (id) => runConnectorAction(connectorDeps, activityLog, id, 'connect'),
      disconnect: (id) => runConnectorAction(connectorDeps, activityLog, id, 'disconnect'),
      test: () => runSelfTest(paths.mcpLauncher),
      activity: () => activityLog.recent()
    },
    background: {
      onStarted: (input) => {
        controller.onStarted(input)
      },
      report: (report) => {
        controller.report(report)
      },
      shortcutStatus: () => shortcuts.status,
      suspendShortcut: (on) => {
        shortcuts.suspend(on)
        controller.refresh()
      }
    },
    liveCapabilities: () => ({ systemAudio: systemAudioSupport(process.platform, release()) }),
    monitorVolume: createMonitorVolume({
      platform: process.platform,
      exec: (file, args, options) => execFileAsync(file, [...args], options)
    }),
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
  const autostart = (enabled: boolean): void => {
    applyAutostart(enabled, {
      platform: process.platform,
      isPackaged: app.isPackaged,
      app,
      env: process.env,
      home: app.getPath('home'),
      execPath: process.execPath
    }).catch((error: unknown) => {
      logger.warn(`[bandeja] iniciar com o sistema: ${String(error)}`)
    })
  }
  shortcuts.apply(settings.get().tray.shortcut)
  autostart(settings.get().tray.openAtLogin)
  let previous = settings.get()
  settings.onChange((next) => {
    if (next.tray.shortcut !== previous.tray.shortcut) shortcuts.apply(next.tray.shortcut)
    if (next.tray.openAtLogin !== previous.tray.openAtLogin) autostart(next.tray.openAtLogin)
    previous = next
    controller.refresh() // idioma, modelo e atalho aparecem no menu
  })
  controller.refresh()
  settings.onChange((next) => {
    applyTheme(nativeTheme, next.theme)
    send(EVENTS.settings, next)
  })

  const startHidden = openedHidden(process.argv, process.platform, () => app.getLoginItemSettings())
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
    },
    startHidden
  })
  keepInTray(window, {
    shouldHide: () => !quitting && settings.get().tray.closeToTray,
    onHidden: () => {
      controller.onWindowHidden()
    }
  })
  // Janela vista (aberta ou só focada): o ponto azul de pedido de IA apaga.
  window.on('show', () => {
    controller.onWindowShown()
  })
  window.on('focus', () => {
    controller.onWindowShown()
  })
  // Windows: desligar o computador com a sessão aberta; o recover() cobre o que não der tempo.
  window.on('session-end', () => {
    void live.stop()
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
  if (process.platform === 'linux') {
    // AppImage: sem atalho .desktop o dock mostra um ícone genérico.
    integrateAppImage({
      appImage: process.env.APPIMAGE,
      home: app.getPath('home'),
      iconSource: windowIcon,
      systemApplications: ['/usr/share/applications', '/usr/local/share/applications']
    })
      .then((result) => {
        if (result === 'written') logger.info('[linux] atalho do AppImage criado ou atualizado')
      })
      .catch((error: unknown) => {
        logger.warn(`[linux] não foi possível criar o atalho do AppImage: ${String(error)}`)
      })
  }

  app.on('second-instance', () => {
    showWindow({ kind: 'window' })
  })
  app.on('activate', () => {
    showWindow({ kind: 'window' }) // macOS: clique no Dock
  })
  app.on('before-quit', (event) => {
    // ⌘Q ou "Sair" do sistema no meio da gravação: finaliza antes (a bandeja faz o mesmo).
    if (!quitting && live.state !== 'idle') {
      event.preventDefault()
      void controller.quit()
      return
    }
    quitting = true
    globalShortcut.unregisterAll()
    tray.destroy()
    queue.shutdown()
    worker.dispose()
    void bridgeServer.close()
  })
  app.on('window-all-closed', () => {
    if (!settings.get().tray.closeToTray) app.quit()
  })
}

/** Conecta/desconecta uma IA e devolve o retrato atualizado dela (spec §10.2). */
async function runConnectorAction(
  deps: ConnectorDeps,
  activity: ActivityLog,
  id: McpClientId,
  action: 'connect' | 'disconnect'
): Promise<ClientStatus> {
  const connector = createConnectors(deps).find((item) => item.id === id)
  if (!connector) throw new AppError('INVALID_REQUEST', 'IA desconhecida')
  await connector[action]()
  const status = (await listClients({ ...deps, activity })).find((item) => item.id === id)
  if (!status) throw new AppError('INVALID_REQUEST', 'IA desconhecida')
  return status
}

/** Modo MCP (argv `--mcp`): desvia antes do `main()`, sem single-instance lock (spec §5.2). */
async function boot(): Promise<void> {
  if (isMcpMode(process.argv)) {
    await runMcp({
      app,
      stdin: process.stdin,
      stdout: process.stdout,
      paths: appPaths(app.getPath('userData')),
      logger: log,
      launcherTarget: launcherTarget({
        platform: process.platform,
        execPath: process.execPath,
        env: process.env,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath()
      })
    })
    return
  }
  await main()
}

boot().catch((error: unknown) => {
  log.error(error)
  app.quit()
})
