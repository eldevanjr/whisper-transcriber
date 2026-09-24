import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema } from '../../src/shared/settings'

describe('settings', () => {
  it('padrões são válidos, sem modelo (onboarding pendente) e em CPU', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.model).toBeNull()
    expect(DEFAULT_SETTINGS.device).toBe('cpu')
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.audioLanguage).toBe('pt')
  })

  it('patch aceita campos parciais e rejeita desconhecidos ou inválidos', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ audioLanguage: 'auto' }).success).toBe(true)
    expect(SettingsPatchSchema.safeParse({ version: 2 }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ hacker: true }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ audioLanguage: 'portuguese' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ model: 'gigante' }).success).toBe(false)
  })
})

describe('settings do ao vivo', () => {
  it('configurações antigas sem "live" ganham o padrão (pausa de 1,0 s)', () => {
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete old.live
    const parsed = SettingsSchema.parse(old)
    expect(parsed.live).toEqual({ micDeviceId: null, systemAudio: true, pauseS: 1.0 })
  })

  it('pausa fora de 0,5–3,0 s é recusada', () => {
    for (const pauseS of [0.4, 3.1]) {
      const live = { ...DEFAULT_SETTINGS.live, pauseS }
      expect(SettingsPatchSchema.safeParse({ live }).success).toBe(false)
    }
    expect(
      SettingsPatchSchema.safeParse({ live: { ...DEFAULT_SETTINGS.live, pauseS: 2 } }).success
    ).toBe(true)
  })
})
