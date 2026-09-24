import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_NAME } from '../shared/app-info'
import { pathExists } from './fs-utils'

const DESKTOP_FILE = 'whisper-transcriber.desktop' // mesmo nome do .deb: é o app_id no Wayland
const MARKER = 'X-Whisper-Transcriber-AppImage=true'

export interface AppImageIntegration {
  /** `process.env.APPIMAGE`: definido só quando o app roda de um AppImage. */
  appImage: string | undefined
  home: string
  iconSource: string
  /** Onde o .deb instala o atalho; com ele presente, nada a fazer. */
  systemApplications: string[]
}

/**
 * Exec entre aspas: `"`, `` ` ``, `$` e `\` levam barra; depois vale o escape das strings do
 * .desktop (a barra dobra) e `%` vira `%%` (códigos de campo).
 */
function execPath(path: string): string {
  const quoted = path.replace(/["`$\\]/g, (char) => `\\${char}`)
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`
}

function desktopEntry(appImage: string, icon: string): string {
  return [
    '[Desktop Entry]',
    `Name=${APP_NAME}`,
    'Comment=Transcreva vídeos e áudios localmente com Whisper',
    `Exec=${execPath(appImage)} %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${icon}`,
    `StartupWMClass=${APP_NAME}`, // a classe da janela: o dock liga a janela a este atalho
    'Categories=AudioVideo;',
    MARKER,
    ''
  ].join('\n')
}

async function readIfExists(path: string): Promise<string | null> {
  return (await pathExists(path)) ? readFile(path, 'utf8') : null
}

/**
 * O AppImage roda sem instalar nada, e sem um atalho .desktop o dock do GNOME mostra um ícone
 * genérico. Cria (ou atualiza, se o AppImage mudou de lugar) o atalho do usuário com o ícone.
 */
export async function integrateAppImage(
  options: AppImageIntegration
): Promise<'skipped' | 'unchanged' | 'written'> {
  const { appImage, home } = options
  if (appImage === undefined) return 'skipped'
  for (const dir of options.systemApplications) {
    if (await pathExists(join(dir, DESKTOP_FILE))) return 'skipped'
  }
  const desktop = join(home, '.local/share/applications', DESKTOP_FILE)
  const current = await readIfExists(desktop)
  if (current !== null && !current.includes(MARKER)) return 'skipped' // atalho da pessoa
  const iconDir = join(home, '.local/share/icons/hicolor/512x512/apps')
  const icon = join(iconDir, 'whisper-transcriber.png')
  const entry = desktopEntry(appImage, icon)
  if (current === entry && (await pathExists(icon))) return 'unchanged'
  await mkdir(iconDir, { recursive: true })
  await copyFile(options.iconSource, icon)
  await mkdir(join(home, '.local/share/applications'), { recursive: true })
  await writeFile(desktop, entry, 'utf8')
  return 'written'
}
