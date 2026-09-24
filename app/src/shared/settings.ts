import { z } from 'zod'
import { MODEL_IDS } from './models'

export const UI_LANGUAGES = ['pt-BR', 'en', 'es'] as const
/** cpu; cuda = GPU NVIDIA (faster-whisper); gpu = outras GPUs via whisper.cpp (Vulkan/Metal). */
export type Device = 'cpu' | 'cuda' | 'gpu'

export const TRACKS = ['voce', 'outros'] as const
/** voce = microfone; outros = áudio do computador (quem está do outro lado da chamada). */
export type Track = (typeof TRACKS)[number]

export const LiveSettingsSchema = z.object({
  micDeviceId: z.string().nullable(), // null = microfone padrão do sistema
  systemAudio: z.boolean(),
  pauseS: z.number().min(0.5).max(3) // pausa que fecha um trecho (frase) no ao vivo
})
export type LiveSettings = z.infer<typeof LiveSettingsSchema>
export const DEFAULT_LIVE_SETTINGS: LiveSettings = {
  micDeviceId: null,
  systemAudio: true,
  pauseS: 1.0
}

export const SettingsSchema = z.object({
  version: z.literal(1),
  uiLanguage: z.enum(UI_LANGUAGES).nullable(), // null = seguir o idioma do sistema
  theme: z.enum(['system', 'light', 'dark']),
  model: z.enum(MODEL_IDS).nullable(), // null = onboarding ainda não concluído
  audioLanguage: z.string().regex(/^(auto|[a-z]{2,3})$/),
  device: z.enum(['cpu', 'cuda', 'gpu']),
  checkUpdates: z.boolean(),
  nvidiaTermsAccepted: z.boolean(),
  // Configurações de antes do ao vivo não têm "live": entram com o padrão.
  live: LiveSettingsSchema.default(DEFAULT_LIVE_SETTINGS)
})
export type Settings = z.infer<typeof SettingsSchema>

export const SettingsPatchSchema = SettingsSchema.omit({ version: true }).partial().strict()
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  uiLanguage: null,
  theme: 'system',
  model: null,
  audioLanguage: 'pt',
  device: 'cpu',
  checkUpdates: true,
  nvidiaTermsAccepted: false,
  live: DEFAULT_LIVE_SETTINGS
}
