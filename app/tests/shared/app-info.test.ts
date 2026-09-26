import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ID, licenseUrls } from '../../src/shared/app-info'
import licenses from '../../resources/third-party-licenses.json'

describe('licenseUrls', () => {
  it('só links https válidos, normalizados como o URL do navegador', () => {
    const entry = { name: 'x', version: '1', license: 'MIT', text: '' }
    expect(
      licenseUrls([
        { ...entry, url: 'https://github.com/facebook/react' },
        { ...entry, url: 'http://inseguro.example' },
        { ...entry, url: '' },
        { ...entry, url: 'https://Pyyaml.org' }
      ])
    ).toEqual(new Set(['https://github.com/facebook/react', 'https://pyyaml.org/']))
  })

  it('o arquivo gerado tem os avisos obrigatórios e nenhum caminho local', () => {
    const names = licenses.map((entry) => entry.name)
    expect(names).toEqual(
      expect.arrayContaining(['Electron', 'Chromium', 'FFmpeg', 'faster-whisper', 'react'])
    )
    expect(JSON.stringify(licenses)).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\/)
  })
})

it('APP_ID é o appId do electron-builder (notificações do Windows dependem disso)', () => {
  const yml = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
  expect(yml).toContain(`appId: ${APP_ID}`)
})
