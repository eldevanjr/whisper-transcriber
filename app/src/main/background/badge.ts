export interface BadgeDeps {
  platform: string
  setOverlay(icon: string | null, description: string): void
  setDockBadge(text: string): void
  overlayIcon: string
}

/** Sessão ao vivo em andamento: overlay na barra de tarefas (Windows) ou bolinha no Dock (macOS). */
export function applyBadge(active: boolean, description: string, deps: BadgeDeps): void {
  if (deps.platform === 'win32') {
    deps.setOverlay(active ? deps.overlayIcon : null, active ? description : '')
  } else if (deps.platform === 'darwin') {
    deps.setDockBadge(active ? '●' : '')
  }
}
