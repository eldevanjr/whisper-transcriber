import { describe, expect, it } from 'vitest'
import {
  FIXED_NOTICES,
  findForbidden,
  fromLicenseChecker,
  fromPipLicenses,
  mergeLicenses,
  normalizeName
} from '../../scripts/licenses-lib.mjs'

describe('licenses-lib', () => {
  it('converte a saída do license-checker, sem o próprio app e sem caminhos locais', () => {
    const entries = fromLicenseChecker(
      {
        'react@19.3.0': {
          name: 'react',
          version: '19.3.0',
          licenses: 'MIT',
          repository: 'https://github.com/facebook/react',
          licenseText: 'MIT License\n...'
        },
        'whisper-transcriber@0.1.0': {
          name: 'whisper-transcriber',
          version: '0.1.0',
          licenses: 'Apache-2.0'
        },
        'dual@1.0.0': {
          name: 'dual',
          version: '1.0.0',
          licenses: ['MIT', 'Apache-2.0'],
          licenseText: ''
        }
      },
      'whisper-transcriber'
    )
    expect(entries).toEqual([
      {
        name: 'react',
        version: '19.3.0',
        license: 'MIT',
        url: 'https://github.com/facebook/react',
        text: 'MIT License\n...'
      },
      { name: 'dual', version: '1.0.0', license: 'MIT OR Apache-2.0', url: '', text: '' }
    ])
  })

  it('converte o pip-licenses filtrando só as dependências de execução', () => {
    const entries = fromPipLicenses(
      [
        {
          Name: 'faster-whisper',
          Version: '1.2.1',
          License: 'MIT',
          URL: 'https://github.com/SYSTRAN/faster-whisper',
          LicenseText: 'MIT...'
        },
        { Name: 'pytest', Version: '9.0', License: 'MIT', URL: 'UNKNOWN', LicenseText: 'x' },
        {
          Name: 'Tokenizers',
          Version: '0.23.2',
          License: 'Apache Software License',
          URL: 'UNKNOWN',
          LicenseText: 'UNKNOWN'
        },
        { Name: 'pydantic_core', Version: '2.46.5', License: 'MIT', URL: 'x', LicenseText: 'y' }
      ],
      new Set(['faster-whisper', 'tokenizers', 'pydantic-core'].map(normalizeName))
    )
    expect(entries).toEqual([
      {
        name: 'faster-whisper',
        version: '1.2.1',
        license: 'MIT',
        url: 'https://github.com/SYSTRAN/faster-whisper',
        text: 'MIT...'
      },
      {
        name: 'Tokenizers',
        version: '0.23.2',
        license: 'Apache Software License',
        url: '',
        text: ''
      },
      { name: 'pydantic_core', version: '2.46.5', license: 'MIT', url: 'x', text: 'y' }
    ])
    expect(normalizeName('Typing.Extensions')).toBe('typing-extensions')
  })

  it('junta, ordena por nome e inclui os avisos fixos (Chromium, FFmpeg, Whisper, NVIDIA)', () => {
    const merged = mergeLicenses([
      [{ name: 'zod', version: '4', license: 'MIT', url: '', text: '' }],
      FIXED_NOTICES
    ])
    expect(merged.map((e) => e.name)).toEqual(
      [...merged.map((e) => e.name)].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' })
      )
    )
    const names = merged.map((e) => e.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'Chromium',
        'FFmpeg',
        'Modelos Whisper (OpenAI)',
        'NVIDIA cuBLAS e cuDNN',
        'Electron',
        'zod'
      ])
    )
    expect(FIXED_NOTICES.find((e) => e.name === 'FFmpeg')?.url).toMatch(/^https:\/\/ffmpeg\.org\//)
  })

  it('acusa GPL/AGPL e licença desconhecida, mas libera LGPL', () => {
    expect(
      findForbidden([
        { name: 'a', version: '1', license: 'GPL-3.0', url: '', text: '' },
        { name: 'b', version: '1', license: 'AGPL-3.0-only', url: '', text: '' },
        { name: 'c', version: '1', license: 'LGPL-2.1-or-later', url: '', text: '' },
        { name: 'd', version: '1', license: 'UNKNOWN', url: '', text: '' },
        { name: 'e', version: '1', license: 'MIT OR GPL-2.0', url: '', text: '' }
      ])
    ).toEqual(['a@1 (GPL-3.0)', 'b@1 (AGPL-3.0-only)', 'd@1 (UNKNOWN)'])
  })
})
