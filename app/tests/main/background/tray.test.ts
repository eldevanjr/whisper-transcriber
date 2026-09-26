import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TrayState } from '../../../src/main/background/state'
import { createTranslate } from '../../../src/main/background/texts'
import { TrayView } from '../../../src/main/background/tray'

const t = createTranslate('pt-BR')
const idle: TrayState = {
  live: 'idle',
  test: false,
  elapsed: 0,
  ready: true,
  shortcut: null,
  aiUnseen: false,
  platform: 'linux'
}

function setup(platform = 'linux') {
  const clicks: (() => void)[] = []
  const tray = {
    setImage: vi.fn(),
    setToolTip: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn((_event: 'click', listener: () => void) => clicks.push(listener))
  }
  const buildMenu = vi.fn((template: unknown) => ({ template }))
  const onAction = vi.fn()
  const view = new TrayView({ tray, buildMenu, iconDir: '/i', platform, onAction })
  return { view, tray, buildMenu, onAction, clicks }
}

describe('TrayView', () => {
  it('aplica ícone, tooltip e menu; só refaz o que mudou', () => {
    const { view, tray, buildMenu } = setup()
    view.render(idle, t)
    expect(tray.setImage).toHaveBeenCalledWith(join('/i', 'tray-normal.png'))
    expect(tray.setToolTip).toHaveBeenCalledWith('Whisper Transcriber')
    expect(tray.setContextMenu).toHaveBeenCalledTimes(1)
    view.render(idle, t) // mesmo estado: o menu aberto não pisca
    expect(tray.setImage).toHaveBeenCalledTimes(1)
    expect(buildMenu).toHaveBeenCalledTimes(1)
    const recording = { ...idle, live: 'recording' as const, elapsed: 3 }
    view.render(recording, t)
    view.render({ ...recording, elapsed: 4 }, t) // só o tempo mudou: tooltip, não o menu
    expect(buildMenu).toHaveBeenCalledTimes(2)
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Gravando — 00:04')
    expect(tray.setTitle).not.toHaveBeenCalled() // só o macOS mostra título
  })

  it('clique num item chama a ação; status e separador não têm clique', () => {
    const { view, buildMenu, onAction } = setup()
    view.render({ ...idle, live: 'recording' }, t)
    const template = buildMenu.mock.lastCall![0] as {
      type?: string
      click?: () => void
      label?: string
    }[]
    expect(template[0]!.click).toBeUndefined()
    expect(template.find((item) => item.type === 'separator')).toEqual({ type: 'separator' })
    template[1]!.click!()
    expect(onAction).toHaveBeenCalledWith('toggle')
  })

  it('macOS: título com o tempo; Windows: clique no ícone abre a janela', () => {
    const mac = setup('darwin')
    mac.view.render({ ...idle, live: 'recording', elapsed: 61 }, t)
    expect(mac.tray.setTitle).toHaveBeenCalledWith('01:01')
    expect(mac.clicks).toHaveLength(0)
    const win = setup('win32')
    win.clicks[0]!()
    expect(win.onAction).toHaveBeenCalledWith('open')
  })
})
