import { describe, expect, it } from 'vitest'
import {
  buildDiagnostic,
  buildIssueUrl,
  ISSUE_URL_MAX,
  scrubPaths
} from '../../src/shared/diagnostics'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

describe('scrubPaths', () => {
  it('troca a pasta pessoal por ~ em Linux, macOS e Windows', () => {
    expect(scrubPaths('/home/joao/Vídeos/a.mp4')).toBe('~/Vídeos/a.mp4')
    expect(scrubPaths('/Users/maria.silva/a.mp4 e /Users/ana/b')).toBe('~/a.mp4 e ~/b')
    expect(scrubPaths('C:\\Users\\José Silva\\Desktop\\a.mp4')).toBe('~\\Desktop\\a.mp4')
    expect(scrubPaths('d:/users/x/a')).toBe('~/a')
    expect(scrubPaths('/var/log/sem pasta pessoal')).toBe('/var/log/sem pasta pessoal')
  })
})

describe('buildDiagnostic', () => {
  it('junta erro, versão, sistema e configurações sem caminhos pessoais', () => {
    const text = buildDiagnostic({
      error: { code: 'INVALID_MEDIA', message: 'ilegível', detail: '/home/joao/a.mp4: moov atom' },
      appInfo: { version: '0.1.0', platform: 'linux', settingsRecovered: false },
      settings: { ...DEFAULT_SETTINGS, model: 'medium' },
      userAgent: 'Mozilla/5.0 Electron/44'
    })
    expect(text).toContain('Whisper Transcriber 0.1.0 (linux)')
    expect(text).toContain('Erro: INVALID_MEDIA — ilegível')
    expect(text).toContain('Detalhe: ~/a.mp4: moov atom')
    expect(text).toContain('Modelo: medium · Dispositivo: cpu · Idioma do áudio: pt')
    expect(text).not.toContain('joao')
  })

  it('sem detalhe e sem configurações carregadas', () => {
    const text = buildDiagnostic({
      error: { code: 'INTERNAL', message: 'x' },
      appInfo: null,
      settings: null,
      userAgent: 'UA'
    })
    expect(
      buildDiagnostic({
        error: { code: 'INTERNAL', message: 'x' },
        appInfo: null,
        settings: DEFAULT_SETTINGS,
        userAgent: 'UA'
      })
    ).toContain('Modelo: ? · Dispositivo: cpu')
    expect(text).toContain('Whisper Transcriber ? (?)')
    expect(text).not.toContain('Detalhe:')
    expect(text).toContain('Modelo: ? · Dispositivo: ? · Idioma do áudio: ?')
  })
})

describe('buildIssueUrl', () => {
  it('abre uma issue nova no repositório com título, rótulo e diagnóstico', () => {
    const url = new URL(buildIssueUrl('Erro: INVALID_MEDIA', 'linha 1\nlinha 2'))
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/eldevanjr/whisper-transcriber/issues/new'
    )
    expect(url.searchParams.get('title')).toBe('Erro: INVALID_MEDIA')
    expect(url.searchParams.get('labels')).toBe('bug')
    expect(url.searchParams.get('body')).toContain('```\nlinha 1\nlinha 2\n```')
  })

  it('corta diagnósticos enormes para caber no limite de URL do GitHub', () => {
    const url = buildIssueUrl('t', 'x'.repeat(20_000))
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX)
    expect(new URL(url).searchParams.get('body')).toContain('…')
  })
})
