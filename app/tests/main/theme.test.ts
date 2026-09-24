import { describe, expect, it } from 'vitest'
import { applyTheme } from '../../src/main/theme'

describe('applyTheme', () => {
  it.each(['system', 'light', 'dark'] as const)('%s vira o themeSource do Chromium', (theme) => {
    const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' }
    applyTheme(nativeTheme, theme)
    expect(nativeTheme.themeSource).toBe(theme)
  })
})
