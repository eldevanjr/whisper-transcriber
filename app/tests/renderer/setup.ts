import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// O jsdom diz "en-US"; os testes partem do idioma principal do app.
Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'pt-BR' })

afterEach(() => {
  cleanup()
})
