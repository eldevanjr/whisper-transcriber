import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_ICON, trayIconDir, trayIconFile } from '../../../src/main/background/icons'

describe('ícones da bandeja', () => {
  it('Windows e Linux: PNG colorido por estado', () => {
    expect(trayIconFile('normal', 'linux')).toBe('tray-normal.png')
    expect(trayIconFile('recording', 'win32')).toBe('tray-recording.png')
    expect(trayIconFile('paused', 'linux')).toBe('tray-paused.png')
    expect(trayIconFile('ai', 'win32')).toBe('tray-ai.png')
  })

  it('macOS: template em repouso, colorido com a bolinha quando há estado', () => {
    expect(trayIconFile('normal', 'darwin')).toBe('trayTemplate.png')
    expect(trayIconFile('recording', 'darwin')).toBe('tray-mac-recording.png')
  })

  it('pasta: resources do instalado ou do projeto em desenvolvimento', () => {
    const base = { resourcesPath: '/r', appPath: '/app' }
    expect(trayIconDir({ ...base, isPackaged: true })).toBe(join('/r', 'tray'))
    expect(trayIconDir({ ...base, isPackaged: false })).toBe(join('/app', 'resources', 'tray'))
    expect(OVERLAY_ICON).toBe('overlay-recording.png')
  })
})
