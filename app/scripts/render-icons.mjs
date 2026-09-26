// Renderiza os ícones com o Chromium do Electron (fiel a gradientes e sombras):
//   build/icon.png (1024, o electron-builder gera .ico e .icns a partir dele)
//   resources/icon.png (512, ícone da janela no Linux)
//   resources/tray/*.png (bandeja: 32 px; macOS 16 px + @2x; overlay do Windows 16 px)
// Uso: pnpm icons
import { app, BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf-8')

// Logo simplificado para 16–32 px: o mesmo balão, sem sombra nem brilho.
const BUBBLE =
  'M14 2 H34 A12 12 0 0 1 46 14 V30 A12 12 0 0 1 34 42 H24 L14 49 V42 A12 12 0 0 1 2 30 V14 A12 12 0 0 1 14 2 Z'
const BARS = [
  [13, 19, 25],
  [19, 14, 30],
  [25, 10, 34],
  [31, 15, 29],
  [37, 19, 25]
]
const DOTS = { recording: '#EF4444', paused: '#F59E0B', ai: '#3B82F6' }

function trayIcon({ template = false, dot = null } = {}) {
  const bars = BARS.map(([x, y1, y2]) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" />`)
  // Template: só o alfa conta; as barras são recortadas do balão por uma máscara.
  const body = template
    ? `<mask id="cut"><rect x="-10" y="-10" width="80" height="80" fill="#fff"/><g stroke="#000" stroke-width="4" stroke-linecap="round">${bars.join('')}</g></mask>
       <path d="${BUBBLE}" fill="#000" mask="url(#cut)"/>`
    : `<path d="${BUBBLE}" fill="#2563EB"/><g stroke="#fff" stroke-width="4" stroke-linecap="round">${bars.join('')}</g>`
  const badge = dot
    ? `<circle cx="41" cy="9" r="9" fill="${DOTS[dot]}" stroke="#fff" stroke-width="3"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-1 0 52 52">${body}${badge}</svg>`
}

const OVERLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#EF4444" stroke="#fff" stroke-width="1.5"/></svg>`

async function render(markup, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false }
  })
  const page = `<html><body style="margin:0;background:transparent">${markup.replace(
    /width="1024" height="1024"/,
    `width="${size}" height="${size}"`
  )}</body></html>`
  const dir = mkdtempSync(join(tmpdir(), 'wt-icon-'))
  writeFileSync(join(dir, 'icon.html'), page)
  await win.loadFile(join(dir, 'icon.html'))
  rmSync(dir, { recursive: true, force: true })
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  win.destroy()
  return image
}

async function renderTray() {
  const out = join(root, 'resources/tray')
  mkdirSync(out, { recursive: true })
  const save = async (name, markup, size) => {
    writeFileSync(join(out, name), (await render(markup, size)).toPNG())
  }
  await save('tray-normal.png', trayIcon(), 32)
  for (const dot of Object.keys(DOTS)) {
    await save(`tray-${dot}.png`, trayIcon({ dot }), 32)
    await save(`tray-mac-${dot}.png`, trayIcon({ dot }), 16)
    await save(`tray-mac-${dot}@2x.png`, trayIcon({ dot }), 32)
  }
  await save('trayTemplate.png', trayIcon({ template: true }), 16)
  await save('trayTemplate@2x.png', trayIcon({ template: true }), 32)
  await save('overlay-recording.png', OVERLAY, 16)
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const image = await render(svg, 1024)
  writeFileSync(join(root, 'build/icon.png'), image.toPNG())
  writeFileSync(
    join(root, 'resources/icon.png'),
    image.resize({ width: 512, height: 512, quality: 'best' }).toPNG()
  )
  await renderTray()
  console.log('ícones gerados: build/icon.png, resources/icon.png e resources/tray/')
  app.quit()
})
