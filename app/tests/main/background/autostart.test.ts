import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyAutostart, openedHidden } from '../../../src/main/background/autostart'
import { pathExists } from '../../../src/main/fs-utils'
import { makeTempDir } from '../../helpers/tmp'

async function setup(patch: Partial<Parameters<typeof applyAutostart>[1]> = {}) {
  const home = await makeTempDir()
  const app = { setLoginItemSettings: vi.fn() }
  const deps = {
    platform: 'linux',
    isPackaged: true,
    app,
    env: {},
    home,
    execPath: '/opt/Whisper Transcriber/whisper-transcriber',
    ...patch
  }
  return { deps, app, file: join(home, '.config/autostart/whisper-transcriber.desktop') }
}

describe('applyAutostart', () => {
  it('em desenvolvimento não mexe em nada', async () => {
    const { deps, app, file } = await setup({ isPackaged: false })
    await applyAutostart(true, deps)
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(await pathExists(file)).toBe(false)
  })

  it('Windows: item de login com --hidden; macOS: escondido', async () => {
    const win = await setup({ platform: 'win32' })
    await applyAutostart(true, win.deps)
    expect(win.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: ['--hidden']
    })
    const mac = await setup({ platform: 'darwin' })
    await applyAutostart(false, mac.deps)
    expect(mac.app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      openAsHidden: true
    })
  })

  it('Linux: .desktop em ~/.config/autostart (deb), regravado e apagado', async () => {
    const { deps, file } = await setup()
    await applyAutostart(true, deps)
    const entry = await readFile(file, 'utf8')
    expect(entry).toContain('Exec="/opt/Whisper Transcriber/whisper-transcriber" --hidden')
    expect(entry).toContain('X-GNOME-Autostart-enabled=true')
    await applyAutostart(true, deps) // regrava sem erro
    await applyAutostart(false, deps)
    expect(await pathExists(file)).toBe(false)
    await applyAutostart(false, deps) // apagar o que não existe não é erro
  })

  it('Linux: AppImage usa $APPIMAGE e respeita $XDG_CONFIG_HOME', async () => {
    const { deps } = await setup()
    const config = join(deps.home, 'cfg')
    await applyAutostart(true, {
      ...deps,
      env: { APPIMAGE: '/home/u/Apps/WT.AppImage', XDG_CONFIG_HOME: config }
    })
    const entry = await readFile(join(config, 'autostart/whisper-transcriber.desktop'), 'utf8')
    expect(entry).toContain('Exec="/home/u/Apps/WT.AppImage" --hidden')
  })
})

describe('openedHidden', () => {
  it('--hidden na linha de comando ou login do macOS', () => {
    const never = () => ({ wasOpenedAtLogin: false })
    expect(openedHidden(['app', '--hidden'], 'linux', never)).toBe(true)
    expect(openedHidden(['app'], 'linux', never)).toBe(false)
    expect(openedHidden(['app'], 'darwin', () => ({ wasOpenedAtLogin: true }))).toBe(true)
    expect(openedHidden(['app'], 'darwin', () => ({}))).toBe(false)
  })
})
