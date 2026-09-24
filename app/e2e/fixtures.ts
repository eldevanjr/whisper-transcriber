import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

// O Playwright compila os testes como CommonJS: __dirname existe.
const HERE = __dirname
const APP_DIR = join(HERE, '..')
const FAKE_WORKER = join(HERE, 'fake-worker.mjs')

export interface AppHandle {
  app: ElectronApplication
  page: Page
  userData: string
}

export function tempDir(prefix = 'wt-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Pasta de dados nova; com `settings`, o app já abre na tela principal (onboarding feito). */
export function makeUserData(settings?: Record<string, unknown>): string {
  const userData = tempDir()
  if (settings) {
    const base = {
      version: 1,
      uiLanguage: 'pt-BR',
      theme: 'light',
      model: 'small',
      audioLanguage: 'pt',
      device: 'cpu',
      checkUpdates: false,
      nvidiaTermsAccepted: false
    }
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ ...base, ...settings }))
  }
  return userData
}

export function mediaFile(name: string): string {
  const path = join(tempDir('wt-media-'), name)
  writeFileSync(path, 'conteúdo de teste')
  return path
}

export async function launch(
  userData: string,
  env: Record<string, string> = {}
): Promise<AppHandle> {
  // Sem ELECTRON_RENDERER_URL: o app carrega o build (out/), como o instalado.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RENDERER_URL' && entry[1] !== undefined
    )
  )
  const app = await electron.launch({
    args: [APP_DIR, '--no-sandbox', '--lang=pt-BR'],
    colorScheme: null, // o Playwright forçaria "light"; o tema vem do nativeTheme do app
    env: {
      ...base,
      WT_USER_DATA: userData,
      WT_WORKER_COMMAND: JSON.stringify({ command: process.execPath, args: [FAKE_WORKER] }),
      ...env
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}

/** Diálogos nativos não podem ser clicados pelo Playwright: trocamos no processo main. */
export async function mockDialogs(
  app: ElectronApplication,
  options: { open?: string[]; save?: string }
): Promise<void> {
  await app.evaluate(({ dialog }, { open, save }) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: open === undefined, filePaths: open ?? [] })
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: save === undefined, filePath: save })) as never
  }, options)
}

export async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

export interface FakeModel {
  manifestPath: string
  files: Record<string, string> // caminho → conteúdo em base64
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Manifesto de teste com um modelo "small" pequeno e hashes reais dos bytes servidos. */
export function fakeModel(): FakeModel {
  const files = {
    'model.bin': randomBytes(256 * 1024),
    'config.json': Buffer.from('{"fake":true}')
  }
  const revision = 'a'.repeat(40)
  const model = {
    repo: 'Systran/faster-whisper-small',
    revision,
    files: Object.entries(files).map(([path, data]) => ({
      path,
      size: data.length,
      sha256: sha256(data)
    }))
  }
  const wheel = {
    name: 'nvidia_fake-1.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/fake/nvidia_fake-1.0-py3-none-any.whl',
    size: 1,
    sha256: sha256(Buffer.from('x'))
  }
  const manifest = {
    version: 1,
    models: { small: model, medium: model, 'large-v3-turbo': model, 'large-v3': model },
    ggml: { small: model, medium: model, 'large-v3-turbo': model, 'large-v3': model },
    cuda: { 'win32-x64': [wheel], 'linux-x64': [wheel] }
  }
  const manifestPath = join(tempDir('wt-manifest-'), 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return {
    manifestPath,
    files: Object.fromEntries(
      Object.entries(files).map(([path, data]) => [path, data.toString('base64')])
    )
  }
}

/** Troca o fetch do main: serve os arquivos do modelo falso e responde a checagem de versão. */
export async function mockNetwork(
  app: ElectronApplication,
  files: Record<string, string>
): Promise<void> {
  await app.evaluate((_electron, served) => {
    globalThis.fetch = ((input: string | URL) => {
      const url = new URL(String(input))
      const name = url.pathname.split('/').pop() ?? ''
      const body = served[name]
      if (url.hostname === 'huggingface.co' && body !== undefined) {
        const bytes = Buffer.from(body, 'base64')
        return Promise.resolve(
          new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })
        )
      }
      return Promise.resolve(new Response('não encontrado', { status: 404 }))
    }) as typeof fetch
  }, files)
}
