import { copyFile } from 'node:fs/promises'
import { z } from 'zod'
import { AppError } from '../../shared/errors'
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema,
  type Settings
} from '../../shared/settings'
import { isNotFound, readJson, writeJsonAtomic } from '../fs-utils'

interface SettingsFiles {
  settings: string
  settingsBackup: string
}

type Listener = (settings: Settings) => void

export class SettingsStore {
  private readonly listeners = new Set<Listener>()
  private updating: Promise<unknown> = Promise.resolve()

  private constructor(
    private current: Settings,
    private readonly path: string,
    readonly recovered: boolean
  ) {}

  static async open(files: SettingsFiles): Promise<SettingsStore> {
    const { settings, recovered } = await load(files)
    return new SettingsStore(settings, files.settings, recovered)
  }

  get(): Settings {
    return this.current
  }

  /** Em fila: cada update parte do resultado do anterior, sem perder mudanças simultâneas. */
  update(patch: unknown): Promise<Settings> {
    const next = this.updating.then(() => this.apply(patch))
    this.updating = next.catch(() => undefined)
    return next
  }

  private async apply(patch: unknown): Promise<Settings> {
    const parsed = SettingsPatchSchema.safeParse(patch)
    if (!parsed.success) {
      throw new AppError('INVALID_REQUEST', 'Configuração inválida', z.prettifyError(parsed.error))
    }
    // O zod mantém chaves enviadas como undefined; elas não podem apagar o valor atual.
    const entries: [string, unknown][] = Object.entries(parsed.data)
    const defined = Object.fromEntries(entries.filter(([, value]) => value !== undefined))
    const next = SettingsSchema.parse({ ...this.current, ...defined })
    await writeJsonAtomic(this.path, next)
    this.current = next
    for (const listener of this.listeners) listener(next)
    return next
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

async function load(files: SettingsFiles): Promise<{ settings: Settings; recovered: boolean }> {
  let raw: unknown
  try {
    raw = await readJson(files.settings)
  } catch (error) {
    if (isNotFound(error)) return { settings: DEFAULT_SETTINGS, recovered: false }
    return recover(files)
  }
  const parsed = SettingsSchema.safeParse(raw)
  return parsed.success ? { settings: parsed.data, recovered: false } : recover(files)
}

async function recover(files: SettingsFiles): Promise<{ settings: Settings; recovered: boolean }> {
  await copyFile(files.settings, files.settingsBackup)
  await writeJsonAtomic(files.settings, DEFAULT_SETTINGS)
  return { settings: DEFAULT_SETTINGS, recovered: true }
}
