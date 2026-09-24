import type { Settings } from '../shared/settings'

type Theme = Settings['theme']

/** "Sistema" deixa o Chromium seguir o SO; claro/escuro forçam o `prefers-color-scheme` do renderer. */
export function applyTheme(nativeTheme: { themeSource: Theme }, theme: Theme): void {
  nativeTheme.themeSource = theme
}
