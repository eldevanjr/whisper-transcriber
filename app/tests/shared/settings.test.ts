import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_MCP_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_TRAY_SETTINGS,
  SettingsPatchSchema,
  SettingsSchema
} from '../../src/shared/settings'

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

describe('settings de IAs (MCP)', () => {
  it('o padrão deixa o acesso desligado e transcrever ligado', () => {
    expect(DEFAULT_MCP_SETTINGS).toEqual({ enabled: false, allowTranscribe: true })
    expect(DEFAULT_SETTINGS.mcp).toEqual(DEFAULT_MCP_SETTINGS)
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).mcp).toEqual(DEFAULT_MCP_SETTINGS)
  })

  it('configurações antigas sem "mcp" ganham o padrão', () => {
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete old.mcp
    const parsed = SettingsSchema.parse(old)
    expect(parsed.mcp).toEqual({ enabled: false, allowTranscribe: true })
  })

  it('patch troca o objeto "mcp" inteiro: parcial é recusado, completo é aceito', () => {
    expect(SettingsPatchSchema.safeParse({ mcp: { enabled: true } }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ mcp: { allowTranscribe: false } }).success).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ mcp: { enabled: true, allowTranscribe: false } })
    ).toMatchObject({
      success: true,
      data: { mcp: { enabled: true, allowTranscribe: false } }
    })
  })
})

describe('configurações da bandeja', () => {
  it('settings sem "tray" (de antes da bandeja) recebem o padrão', () => {
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete old.tray
    expect(SettingsSchema.parse(old).tray).toEqual(DEFAULT_TRAY_SETTINGS)
    expect(DEFAULT_TRAY_SETTINGS).toEqual({
      closeToTray: true,
      openAtLogin: true,
      shortcut: 'CommandOrControl+Alt+R',
      notifyAi: true
    })
  })

  it('atalho: accelerator válido ou null; o resto é recusado', () => {
    const patch = (shortcut: unknown) =>
      SettingsPatchSchema.safeParse({ tray: { ...DEFAULT_TRAY_SETTINGS, shortcut } }).success
    expect(patch('Alt+F9')).toBe(true)
    expect(patch(null)).toBe(true)
    expect(patch('Shift+R')).toBe(false)
    expect(patch('Alt')).toBe(false)
  })
})

describe('configurações da IA local', () => {
  it('padrão vem desligado, com Ollama local e workspace "default"', () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_AI_SETTINGS.ollamaUrl).toBe('http://localhost:11434')
    expect(DEFAULT_AI_SETTINGS.workspaceId).toBe('default')
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).ai).toEqual(DEFAULT_AI_SETTINGS)
  })

  it('settings sem "ai" (de antes da IA) recebem o padrão', () => {
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete old.ai
    expect(SettingsSchema.parse(old).ai).toEqual(DEFAULT_AI_SETTINGS)
  })

  it('patch troca o objeto "ai" inteiro: parcial é recusado, completo é aceito', () => {
    expect(SettingsPatchSchema.safeParse({ ai: { enabled: true } }).success).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...DEFAULT_AI_SETTINGS, enabled: true } }).success
    ).toBe(true)
  })

  it('overlap deve ser menor que a janela', () => {
    const ai = { ...DEFAULT_AI_SETTINGS, analysisWindowSeconds: 10, analysisOverlapSeconds: 10 }
    expect(SettingsPatchSchema.safeParse({ ai }).success).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({
        ai: { ...ai, analysisOverlapSeconds: 5 }
      }).success
    ).toBe(true)
  })

  it('Ollama remoto começa bloqueado e settings antigas de IA recebem o padrão', () => {
    expect(DEFAULT_AI_SETTINGS.allowRemoteOllama).toBe(false)
    const old: Partial<typeof DEFAULT_AI_SETTINGS> = { ...DEFAULT_AI_SETTINGS }
    delete old.allowRemoteOllama
    const parsed = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ai: old })
    expect(parsed.ai.allowRemoteOllama).toBe(false)
  })

  it('aceita o modo automático do banco', () => {
    const ai = { ...DEFAULT_AI_SETTINGS, storage: { ...DEFAULT_AI_SETTINGS.storage, mode: 'auto' } }
    expect(SettingsPatchSchema.safeParse({ ai }).success).toBe(true)
  })
})
