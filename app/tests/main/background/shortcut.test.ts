import { describe, expect, it, vi } from 'vitest'
import { Shortcuts } from '../../../src/main/background/shortcut'

function setup(options: { free?: boolean; wayland?: boolean; throws?: boolean } = {}) {
  const registered = new Map<string, () => void>()
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (options.throws) throw new TypeError('conversion failure')
      if (options.free === false) return false
      registered.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => registered.delete(accelerator))
  }
  const onPress = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const shortcuts = new Shortcuts({
    globalShortcut,
    onPress,
    wayland: options.wayland ?? false,
    logger
  })
  return { shortcuts, globalShortcut, registered, onPress, logger }
}

describe('Shortcuts', () => {
  it('registra, troca (desfaz o anterior) e desliga', () => {
    const { shortcuts, registered, onPress } = setup()
    expect(shortcuts.apply('CommandOrControl+Alt+R')).toBe('ok')
    expect(shortcuts.active).toBe('CommandOrControl+Alt+R')
    registered.get('CommandOrControl+Alt+R')!()
    expect(onPress).toHaveBeenCalled()
    expect(shortcuts.apply('Alt+F9')).toBe('ok')
    expect([...registered.keys()]).toEqual(['Alt+F9'])
    expect(shortcuts.apply(null)).toBe('off')
    expect(registered.size).toBe(0)
    expect(shortcuts.active).toBeNull()
    expect(shortcuts.status).toBe('off')
  })

  it('combinação ocupada; no Wayland o portal pode recusar', () => {
    expect(setup({ free: false }).shortcuts.apply('Alt+R')).toBe('taken')
    const wayland = setup({ free: false, wayland: true })
    expect(wayland.shortcuts.apply('Alt+R')).toBe('unavailable')
    expect(wayland.shortcuts.active).toBeNull()
  })

  it('accelerator que o Electron não entende vira "ocupado", com log', () => {
    const { shortcuts, logger } = setup({ throws: true })
    expect(shortcuts.apply('Alt+R')).toBe('taken')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('suspenso enquanto a tela grava um atalho novo; volta ao soltar', () => {
    const { shortcuts, registered } = setup()
    shortcuts.apply('Alt+R')
    shortcuts.suspend(true)
    expect(registered.size).toBe(0)
    expect(shortcuts.apply('Alt+F9')).toBe('ok') // salvo durante a suspensão: registra ao soltar
    expect(registered.size).toBe(0)
    shortcuts.suspend(false)
    expect([...registered.keys()]).toEqual(['Alt+F9'])
    shortcuts.suspend(false) // soltar de novo não duplica
    expect(registered.size).toBe(1)
  })
})
