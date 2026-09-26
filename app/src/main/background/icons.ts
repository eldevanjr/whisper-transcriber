import { join } from 'node:path'

export type TrayIconState = 'normal' | 'recording' | 'paused' | 'ai'

/** Bolinha vermelha na barra de tarefas do Windows enquanto grava. */
export const OVERLAY_ICON = 'overlay-recording.png'

/**
 * PNG de `resources/tray` (gerados por `pnpm icons`). No macOS o ícone em repouso é "template"
 * (o sistema pinta conforme o tema da barra); com estado, colorido para a bolinha aparecer.
 * O Electron pega o `@2x` ao lado sozinho.
 */
export function trayIconFile(state: TrayIconState, platform: string): string {
  if (platform !== 'darwin') return `tray-${state}.png`
  return state === 'normal' ? 'trayTemplate.png' : `tray-mac-${state}.png`
}

export function trayIconDir(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'tray')
    : join(options.appPath, 'resources', 'tray')
}
