import { describe, expect, it } from 'vitest'
import {
  iconState,
  menuModel,
  tooltip,
  trayTitle,
  type TrayState
} from '../../../src/main/background/state'
import { createTranslate } from '../../../src/main/background/texts'

const t = createTranslate('pt-BR')
const base: TrayState = {
  live: 'idle',
  test: false,
  elapsed: 0,
  ready: true,
  shortcut: 'CommandOrControl+Alt+R',
  aiUnseen: false,
  platform: 'linux'
}
const labels = (state: TrayState) =>
  menuModel(state, t).map((entry) => (entry.type === 'item' ? entry.label : '—'))

describe('estado da bandeja', () => {
  it('parado: começar (com o atalho), abrir e sair', () => {
    expect(labels(base)).toEqual([
      'Começar gravação (Ctrl+Alt+R)',
      '—',
      'Abrir Whisper Transcriber',
      '—',
      'Sair'
    ])
    expect(iconState(base)).toBe('normal')
    expect(tooltip(base, t)).toBe('Whisper Transcriber')
    expect(trayTitle(base)).toBe('')
  })

  it('gravando: status, parar, pausar; ícone vermelho e tempo', () => {
    const state = { ...base, live: 'recording' as const, elapsed: 75, shortcut: null }
    expect(labels(state)).toEqual([
      '● Gravando',
      'Parar gravação',
      'Pausar',
      '—',
      'Abrir Whisper Transcriber',
      '—',
      'Sair'
    ])
    const [status, toggle, pause] = menuModel(state, t)
    expect(status).toMatchObject({ action: null, enabled: false })
    expect(toggle).toMatchObject({ action: 'toggle', enabled: true })
    expect(pause).toMatchObject({ action: 'pause' })
    expect(iconState(state)).toBe('recording')
    expect(tooltip(state, t)).toBe('Gravando — 01:15')
    expect(trayTitle(state)).toBe('01:15')
  })

  it('em pausa: retomar e ícone amarelo; gravação vence o ponto de IA', () => {
    const state = { ...base, live: 'paused' as const, elapsed: 5, aiUnseen: true }
    expect(labels(state)).toContain('Retomar')
    expect(labels(state)[0]).toBe('● Em pausa')
    expect(menuModel(state, t)[2]).toMatchObject({ action: 'resume' })
    expect(iconState(state)).toBe('paused')
    expect(tooltip(state, t)).toBe('Em pausa — 00:05')
  })

  it('pedido de IA não visto: ponto azul fora da gravação', () => {
    expect(iconState({ ...base, aiUnseen: true })).toBe('ai')
  })

  it('teste da tela: não conta como gravação, mas o item vira "Parar"', () => {
    const state = { ...base, live: 'recording' as const, test: true }
    expect(iconState(state)).toBe('normal')
    expect(labels(state)[0]).toBe('Parar gravação (Ctrl+Alt+R)')
  })

  it('começando/parando: item desativado; sem modelo: "Termine a configuração"', () => {
    expect(menuModel({ ...base, live: 'stopping' }, t)[0]).toMatchObject({ enabled: false })
    const setup = menuModel({ ...base, ready: false }, t)
    expect(setup[0]).toMatchObject({ enabled: false })
    expect(setup[1]).toMatchObject({ label: 'Termine a configuração', action: 'setup' })
  })

  it('macOS mostra o atalho com símbolos', () => {
    expect(labels({ ...base, platform: 'darwin' })[0]).toBe('Começar gravação (⌘⌥R)')
  })
})
