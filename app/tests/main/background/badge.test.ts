import { describe, expect, it, vi } from 'vitest'
import { applyBadge } from '../../../src/main/background/badge'

const deps = (platform: string) => ({
  platform,
  setOverlay: vi.fn(),
  setDockBadge: vi.fn(),
  overlayIcon: '/i/overlay.png'
})

describe('applyBadge', () => {
  it('Windows: overlay vermelho na barra de tarefas enquanto grava', () => {
    const win = deps('win32')
    applyBadge(true, 'Gravando', win)
    expect(win.setOverlay).toHaveBeenLastCalledWith('/i/overlay.png', 'Gravando')
    applyBadge(false, 'Gravando', win)
    expect(win.setOverlay).toHaveBeenLastCalledWith(null, '')
  })

  it('macOS: bolinha no Dock; Linux: nada', () => {
    const mac = deps('darwin')
    applyBadge(true, 'x', mac)
    expect(mac.setDockBadge).toHaveBeenLastCalledWith('●')
    applyBadge(false, 'x', mac)
    expect(mac.setDockBadge).toHaveBeenLastCalledWith('')
    const linux = deps('linux')
    applyBadge(true, 'x', linux)
    expect(linux.setOverlay).not.toHaveBeenCalled()
    expect(linux.setDockBadge).not.toHaveBeenCalled()
  })
})
