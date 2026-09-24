import '@fontsource-variable/inter'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createI18n, resolveLanguage } from './i18n'
import { AppProviders } from './providers'
import { createAppStore } from './store/app-store'

// Bootstrap fino (coberto pelo E2E): a API vem do preload via contextBridge.
const api = window.transcriber
const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AppProviders
        api={api}
        store={createAppStore(api)}
        i18n={createI18n(resolveLanguage(null, navigator.language))}
      >
        <App />
      </AppProviders>
    </StrictMode>
  )
}
