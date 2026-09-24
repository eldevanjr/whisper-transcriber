import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { integrateAppImage } from '../../src/main/linux-integration'
import { pathExists } from '../../src/main/fs-utils'
import { makeTempDir } from '../helpers/tmp'

async function setup() {
  const home = await makeTempDir()
  const icon = join(home, 'icon.png')
  await writeFile(icon, 'png')
  const systemDir = join(home, 'usr-share-applications')
  return {
    home,
    options: {
      appImage: '/home/u/Apps/Whisper Transcriber.AppImage',
      home,
      iconSource: icon,
      systemApplications: [systemDir]
    },
    desktop: join(home, '.local/share/applications/whisper-transcriber.desktop'),
    iconTarget: join(home, '.local/share/icons/hicolor/512x512/apps/whisper-transcriber.png'),
    systemDir
  }
}

describe('integrateAppImage', () => {
  it('fora do AppImage não faz nada', async () => {
    const { options, desktop } = await setup()
    expect(await integrateAppImage({ ...options, appImage: undefined })).toBe('skipped')
    expect(await pathExists(desktop)).toBe(false)
  })

  it('cria o atalho com o ícone e a mesma classe de janela do .deb (o dock acha o ícone)', async () => {
    const { options, desktop, iconTarget } = await setup()
    expect(await integrateAppImage(options)).toBe('written')
    const entry = await readFile(desktop, 'utf8')
    expect(entry).toContain('Exec="/home/u/Apps/Whisper Transcriber.AppImage" %U\n')
    expect(entry).toContain('StartupWMClass=Whisper Transcriber\n')
    expect(entry).toContain(`Icon=${iconTarget}\n`)
    expect(entry).toContain('X-Whisper-Transcriber-AppImage=true\n')
    expect(await readFile(iconTarget, 'utf8')).toBe('png')
  })

  it('não regrava sem mudança; AppImage movido ou atualizado atualiza o caminho', async () => {
    const { options, desktop } = await setup()
    await integrateAppImage(options)
    const before = (await stat(desktop)).mtimeMs
    expect(await integrateAppImage(options)).toBe('unchanged')
    expect((await stat(desktop)).mtimeMs).toBe(before)
    const moved = { ...options, appImage: '/opt/wt/Whisper-Transcriber-0.2.0.AppImage' }
    expect(await integrateAppImage(moved)).toBe('written')
    expect(await readFile(desktop, 'utf8')).toContain(
      'Exec="/opt/wt/Whisper-Transcriber-0.2.0.AppImage"'
    )
  })

  it('com o .deb instalado, o atalho do sistema já resolve: não cria outro', async () => {
    const { options, desktop, systemDir } = await setup()
    await mkdir(systemDir, { recursive: true })
    await writeFile(join(systemDir, 'whisper-transcriber.desktop'), '[Desktop Entry]')
    expect(await integrateAppImage(options)).toBe('skipped')
    expect(await pathExists(desktop)).toBe(false)
  })

  it('não sobrescreve um atalho que a pessoa criou à mão', async () => {
    const { options, desktop } = await setup()
    await mkdir(join(desktop, '..'), { recursive: true })
    await writeFile(desktop, '[Desktop Entry]\nName=Meu atalho\n')
    expect(await integrateAppImage(options)).toBe('skipped')
    expect(await readFile(desktop, 'utf8')).toContain('Meu atalho')
  })

  it('aspas, barras, $ e % no caminho seguem o escape da especificação do .desktop', async () => {
    const { options, desktop } = await setup()
    await integrateAppImage({ ...options, appImage: '/tmp/a "b" \\c $d 5%.AppImage' })
    // Aspas: \" e depois a barra dobra (\\"). Barra: \\ e depois \\\\. % vira %%.
    expect(await readFile(desktop, 'utf8')).toContain(
      String.raw`Exec="/tmp/a \\"b\\" \\\\c \\$d 5%%.AppImage" %U`
    )
  })
})
