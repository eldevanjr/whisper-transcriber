import { z } from 'zod'
import { AppError, toAppError } from '../../shared/errors'
import type { SystemInfo, UpdateInfo } from '../../shared/events'
import { isJobId, type HistoryMeta } from '../../shared/history'
import {
  IPC,
  SEND,
  type AppInfo,
  type IpcResult,
  type LiveCapabilities,
  type LiveStartInput
} from '../../shared/ipc'
import { formatForDevice, MODEL_FORMATS, MODEL_IDS } from '../../shared/models'
import { TRACKS, type Track } from '../../shared/settings'
import type { Installer } from '../downloads/installer'
import { pathExists } from '../fs-utils'
import type { HistoryStore } from '../history/store'
import type { TranscriptionQueue } from '../queue/queue'
import { isAllowedExternalUrl, type SenderEvent } from '../security'
import type { SettingsStore } from '../settings/store'

export type IpcEventLike = SenderEvent

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): void
}

export interface Services {
  settings: SettingsStore
  queue: TranscriptionQueue
  history: HistoryStore
  installer: Installer
  dialogs: {
    chooseFiles(): Promise<string[]>
    saveText(defaultName: string, content: string): Promise<boolean>
  }
  clipboard: { writeText(text: string): Promise<void> | void }
  shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string> }
  systemInfo(): Promise<SystemInfo>
  checkUpdates(): Promise<UpdateInfo | null>
  installUpdate(): void
  dataDir: string
  appInfo(): AppInfo
  /** Links extras permitidos (páginas dos projetos em Licenças). */
  externalUrls: ReadonlySet<string>
  liveCapabilities(): LiveCapabilities
  live: {
    start(input: LiveStartInput): Promise<{ sessionId: string; itemId: string | null }>
    stop(): Promise<HistoryMeta | null>
    pause(): void
    resume(): void
    audio(track: Track, seq: number, pcm: Int16Array): void
  }
}

const None = z.undefined()
const JobId = z.string().refine(isJobId, 'identificador inválido')
const SetVersionSchema = z.object({ id: JobId, version: z.enum(['live', 'redo']) })
const ModelIdSchema = z.enum(MODEL_IDS)
const FormatSchema = z.enum(MODEL_FORMATS)
const ModelRefSchema = z.object({ id: ModelIdSchema, format: FormatSchema.default('ct2') })
const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), id: ModelIdSchema, format: FormatSchema.optional() }),
  z.object({ kind: z.literal('cuda') })
])
const PathSchema = z.string().min(1).max(4096)
const PathsSchema = z.array(PathSchema).min(1).max(500)
const RetrySchema = z.object({ id: JobId, sourcePath: PathSchema.optional() })
const SaveSchema = z.object({
  defaultName: z.string().min(1).max(255),
  content: z.string().max(50_000_000)
})
const TextSchema = z.string().max(50_000_000)
const UrlSchema = z.string().max(2048)
const TrackSchema = z.enum(TRACKS)
const LiveStartSchema = z.object({
  tracks: z
    .array(TrackSchema)
    .min(1)
    .max(2)
    .refine((tracks) => new Set(tracks).size === tracks.length, 'faixas repetidas'),
  test: z.boolean(),
  title: z.string().min(1).max(200)
})
const BLOCK_48K = 4800 // 100 ms a 48 kHz
const LiveAudioSchema = z.object({
  track: TrackSchema,
  seq: z.number().int().min(0),
  pcm: z.instanceof(Int16Array).refine((pcm) => pcm.length === BLOCK_48K, 'bloco de 100 ms')
})

type On = <S extends z.ZodType>(
  channel: string,
  schema: S,
  run: (arg: z.output<S>) => unknown
) => void

export function sanitizeFileName(name: string): string {
  // Troca separadores de pasta, caracteres proibidos no Windows e caracteres de controle.
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 200)
  return cleaned === '' ? 'transcricao.txt' : cleaned
}

async function invoke<S extends z.ZodType>(
  trusted: boolean,
  raw: unknown,
  schema: S,
  run: (arg: z.output<S>) => unknown
): Promise<IpcResult<unknown>> {
  try {
    if (!trusted) throw new AppError('INVALID_REQUEST', 'Origem não autorizada')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new AppError('INVALID_REQUEST', 'Parâmetros inválidos', z.prettifyError(parsed.error))
    }
    return { ok: true, data: (await run(parsed.data)) ?? null }
  } catch (error) {
    return { ok: false, error: toAppError(error).toInfo() }
  }
}

export function registerIpcHandlers(
  ipc: IpcMainLike,
  services: Services,
  isTrusted: (event: IpcEventLike) => boolean
): void {
  const on: On = (channel, schema, run) => {
    ipc.handle(channel, (event, raw) => invoke(isTrusted(event), raw, schema, run))
  }
  registerSettingsAndQueue(on, services)
  registerHistory(on, services)
  registerDownloads(on, services)
  registerSystem(on, services)
  registerLive(on, services)
  // Blocos de áudio: canal sem resposta (send), validado e só do renderer do app.
  ipc.on(SEND.liveAudio, (event, raw) => {
    const parsed = LiveAudioSchema.safeParse(raw)
    if (isTrusted(event) && parsed.success) {
      services.live.audio(parsed.data.track, parsed.data.seq, parsed.data.pcm)
    }
  })
}

function registerLive(on: On, s: Services): void {
  on(IPC.liveCapabilities, None, () => s.liveCapabilities())
  on(IPC.liveStart, LiveStartSchema, (input) => s.live.start(input))
  on(IPC.liveStop, None, () => s.live.stop())
  on(IPC.livePause, None, () => {
    s.live.pause()
    return null
  })
  on(IPC.liveResume, None, () => {
    s.live.resume()
    return null
  })
}

function registerSettingsAndQueue(on: On, s: Services): void {
  on(IPC.settingsGet, None, () => s.settings.get())
  on(IPC.settingsUpdate, z.unknown(), (patch) => s.settings.update(patch))
  on(IPC.queueEnqueue, PathsSchema, (paths) => s.queue.enqueue(paths))
  on(IPC.queueRemove, JobId, (id) => s.queue.remove(id))
  on(IPC.queueCancel, None, () => {
    s.queue.cancel()
  })
  on(IPC.queueState, None, () => s.queue.state())
  on(IPC.queueRetry, RetrySchema, ({ id, sourcePath }) => s.queue.retry(id, sourcePath))
  on(IPC.engineSelfTest, None, () => s.queue.selfTest())
}

function registerHistory(on: On, s: Services): void {
  on(IPC.historyList, None, () => s.history.list())
  on(IPC.historyGet, JobId, async (id) => {
    const meta = await s.history.get(id)
    const transcript = await s.history.readActive(meta)
    const videoAvailable = meta.mediaKind === 'video' && (await pathExists(meta.sourcePath))
    return { meta, transcript, videoAvailable, hasRedo: await s.history.hasRedo(meta) }
  })
  on(IPC.historySetVersion, SetVersionSchema, ({ id, version }) => s.queue.setVersion(id, version))
  on(IPC.historyStats, None, () => s.history.stats())
  on(IPC.historyRemove, JobId, (id) => s.queue.removeEntry(id))
  on(IPC.historyClear, None, () => {
    if (!s.queue.isIdle())
      throw new AppError('INVALID_REQUEST', 'Aguarde a fila terminar para limpar o histórico')
    return s.history.clear()
  })
}

function registerDownloads(on: On, s: Services): void {
  on(IPC.modelsStatus, FormatSchema.default('ct2'), async (format) => ({
    installed: await s.installer.installedModels(format),
    partial: await s.installer.partialModels(format),
    sizes: s.installer.modelSizes(format)
  }))
  on(IPC.modelsInstall, ModelRefSchema, ({ id, format }) => s.installer.installModel(id, format))
  on(IPC.modelsRemove, ModelRefSchema, ({ id, format }) => {
    const settings = s.settings.get()
    if (settings.model === id && formatForDevice(settings.device) === format) {
      throw new AppError('INVALID_REQUEST', 'Escolha outro modelo antes de remover este')
    }
    return s.installer.removeModel(id, format)
  })
  on(IPC.cudaStatus, None, async () => ({
    supported: s.installer.cudaSupported(),
    installed: await s.installer.isCudaInstalled(),
    sizeBytes: s.installer.cudaSize()
  }))
  on(IPC.cudaInstall, None, () => {
    if (!s.settings.get().nvidiaTermsAccepted) {
      throw new AppError('INVALID_REQUEST', 'É preciso aceitar os termos da NVIDIA')
    }
    return s.installer.installCuda()
  })
  on(IPC.cudaRemove, None, async () => {
    if (s.settings.get().device === 'cuda') await s.settings.update({ device: 'cpu' })
    await s.installer.removeCuda()
  })
  on(IPC.downloadCancel, TargetSchema, (target) => {
    s.installer.cancel(target)
  })
}

function registerSystem(on: On, s: Services): void {
  on(IPC.filesChoose, None, () => s.dialogs.chooseFiles())
  on(IPC.fileSave, SaveSchema, ({ defaultName, content }) =>
    s.dialogs.saveText(sanitizeFileName(defaultName), content)
  )
  on(IPC.clipboardWrite, TextSchema, async (text) => {
    await s.clipboard.writeText(text)
  })
  on(IPC.systemInfo, None, () => s.systemInfo())
  on(IPC.openExternal, UrlSchema, (url) => {
    if (!isAllowedExternalUrl(url, s.externalUrls)) {
      throw new AppError('INVALID_REQUEST', 'Link não permitido')
    }
    return s.shell.openExternal(url)
  })
  on(IPC.openDataFolder, None, async () => {
    await s.shell.openPath(s.dataDir)
  })
  on(IPC.appInfo, None, () => s.appInfo())
  on(IPC.updatesCheck, None, () => (s.settings.get().checkUpdates ? s.checkUpdates() : null))
  on(IPC.updatesInstall, None, () => {
    s.installUpdate()
    return null
  })
}
