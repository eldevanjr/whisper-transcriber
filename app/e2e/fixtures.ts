import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

// O Playwright compila os testes como CommonJS: __dirname existe.
const HERE = __dirname
const APP_DIR = join(HERE, '..')
const FAKE_WORKER = join(HERE, 'fake-worker.mjs')

/** Executável do Electron do projeto; é o comando que o lançador usa em desenvolvimento. */
export const ELECTRON_BIN = join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron')
/** Mesma linha do worker falso que `launch` passa ao app. */
export const FAKE_WORKER_COMMAND = JSON.stringify({
  command: process.execPath,
  args: [FAKE_WORKER]
})
/** Fixture de áudio real usada nos testes de transcrição (silêncio válido em m4a). */
export const SILENCE_FIXTURE = join(HERE, 'fixtures', 'silence.m4a')

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

/**
 * Cópia da fixture `silence.m4a` numa pasta com "lento" no nome: o worker falso vê o trecho
 * "lento" no caminho e desacelera (1,5 s por trecho), dando tempo de observar o `pct` subindo.
 */
export function slowMediaFile(name = 'silence.m4a'): string {
  const path = join(tempDir('wt-lento-'), name)
  copyFileSync(SILENCE_FIXTURE, path)
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
    args: [
      APP_DIR,
      '--no-sandbox',
      '--lang=pt-BR',
      // Microfone falso do Chromium (um bipe a cada 500 ms), sem pedir permissão: testa o ao vivo.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    ],
    colorScheme: null, // o Playwright forçaria "light"; o tema vem do nativeTheme do app
    env: {
      ...base,
      WT_USER_DATA: userData,
      WT_WORKER_COMMAND: FAKE_WORKER_COMMAND,
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

export interface McpHandle {
  client: Client
  userData: string
  close(): Promise<void>
}

/**
 * Sobe o processo `--mcp` do build (`out/`, via `package.json`) com o mesmo `userData` do teste e
 * conecta um cliente do SDK por stdio, como uma IA local faria pelo lançador. O processo não cria
 * janela; quando fechado, o próprio `transcribe_file` abre o app.
 */
export async function connectMcp(
  userData: string,
  options: { clientName?: string; env?: Record<string, string> } = {}
): Promise<McpHandle> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== 'ELECTRON_RENDERER_URL' && entry[1] !== undefined
    )
  )
  const transport = new StdioClientTransport({
    command: ELECTRON_BIN,
    args: [APP_DIR, '--mcp'],
    stderr: 'ignore',
    env: {
      ...base,
      WT_USER_DATA: userData,
      WT_WORKER_COMMAND: FAKE_WORKER_COMMAND,
      // Sem o chrome-sandbox SUID neste ambiente, o Electron precisa disto (vale para o app aberto).
      ELECTRON_DISABLE_SANDBOX: '1',
      ...options.env
    }
  })
  const client = new Client(
    { name: options.clientName ?? 'claude-code', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(transport)
  return { client, userData, close: () => client.close() }
}

/** Títulos das janelas X11 do app; usada para ver que o `transcribe_file` abriu a janela. */
export function appWindowTitles(): string {
  try {
    const ids = execFileSync('xdotool', ['search', '--name', 'Whisper Transcriber'])
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
    return ids
      .map((id) => execFileSync('xdotool', ['getwindowname', id]).toString().trim())
      .join('\n')
  } catch {
    return ''
  }
}

/** Encerra o app que o processo MCP abriu (pid no `bridge.json`) para não vazar entre testes. */
export async function killSpawnedApp(userData: string): Promise<void> {
  let pid: number
  try {
    pid = (
      JSON.parse(readFileSync(join(userData, 'mcp', 'bridge.json'), 'utf8')) as { pid: number }
    ).pid
  } catch {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // já saiu
  }
}
