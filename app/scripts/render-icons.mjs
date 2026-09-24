// Renderiza build/icon.svg com o Chromium do Electron (fiel a gradientes e sombras):
//   build/icon.png (1024, o electron-builder gera .ico e .icns a partir dele)
//   resources/icon.png (512, ícone da janela no Linux)
// Uso: pnpm icons
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf-8')

async function render(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true, javascript: false }
  })
  const page = `<html><body style="margin:0;background:transparent">${svg.replace(
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

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const image = await render(1024)
  writeFileSync(join(root, 'build/icon.png'), image.toPNG())
  writeFileSync(
    join(root, 'resources/icon.png'),
    image.resize({ width: 512, height: 512, quality: 'best' }).toPNG()
  )
  console.log('ícones gerados: build/icon.png (1024), resources/icon.png (512)')
  app.quit()
})
