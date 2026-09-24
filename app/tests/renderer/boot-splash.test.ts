import { describe, expect, it } from 'vitest'
import html from '../../src/renderer/index.html?raw'

describe('tela de carregamento do index.html', () => {
  it('aparece antes do JavaScript: logo com as barras animadas dentro do #root', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const splash = doc.querySelector('#root .boot')
    expect(splash).not.toBeNull()
    expect(splash?.querySelectorAll('.boot-bar')).toHaveLength(5)
    expect(splash?.textContent).toContain('Whisper Transcriber')
  })

  it('segue o tema do sistema, respeita movimento reduzido e não usa script inline', () => {
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('prefers-reduced-motion: reduce')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const scripts = [...doc.querySelectorAll('script')]
    expect(scripts.every((s) => s.getAttribute('src') !== null)).toBe(true)
    expect(html).toContain("script-src 'self';")
  })
})
