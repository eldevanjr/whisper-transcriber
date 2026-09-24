import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyVersion, pep440, setVersion } from '../../scripts/set-version.mjs'
import { makeTempDir } from '../helpers/tmp'

const SOURCES = {
  packageJson:
    '{\n  "name": "whisper-transcriber",\n  "version": "0.0.0-dev",\n  "private": true\n}\n',
  pyproject:
    '[project]\nname = "transcriber-worker"\nversion = "0.0.0.dev0"\n\n[tool.ruff]\ntarget-version = "py312"\n',
  init: '"""Worker."""\n\n__version__ = "0.0.0-dev"\nPROTOCOL_VERSION = 2\n'
}

describe('set-version', () => {
  it('grava a mesma versão nas três fontes, sem mexer no resto', () => {
    const out = applyVersion(SOURCES, '1.2.3')
    expect(JSON.parse(out.packageJson)).toEqual({
      name: 'whisper-transcriber',
      version: '1.2.3',
      private: true
    })
    expect(out.pyproject).toContain('version = "1.2.3"\n')
    expect(out.pyproject).toContain('target-version = "py312"') // só a linha do [project]
    expect(out.init).toBe('"""Worker."""\n\n__version__ = "1.2.3"\nPROTOCOL_VERSION = 2\n')
  })

  it('pré-release vira PEP 440 no pyproject; o __version__ casa com o app', () => {
    expect(pep440('0.0.0-dev')).toBe('0.0.0.dev0')
    expect(pep440('1.0.0-rc.1')).toBe('1.0.0rc1')
    expect(pep440('2.3.4')).toBe('2.3.4')
    const out = applyVersion(SOURCES, '1.0.0-rc.1')
    expect(out.pyproject).toContain('version = "1.0.0rc1"')
    expect(out.init).toContain('__version__ = "1.0.0-rc.1"')
  })

  it('recusa versão fora do SemVer', () => {
    expect(() => applyVersion(SOURCES, 'v1.2')).toThrow('SemVer')
    expect(() => pep440('1.0.0-beta')).toThrow('pré-release')
  })

  it('reescreve os arquivos do repositório', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'app'))
    await mkdir(join(root, 'worker/transcriber_worker'), { recursive: true })
    await writeFile(join(root, 'app/package.json'), SOURCES.packageJson)
    await writeFile(join(root, 'worker/pyproject.toml'), SOURCES.pyproject)
    await writeFile(join(root, 'worker/transcriber_worker/__init__.py'), SOURCES.init)
    await setVersion(root, '0.1.0')
    expect(await readFile(join(root, 'app/package.json'), 'utf-8')).toContain('"version": "0.1.0"')
    expect(await readFile(join(root, 'worker/pyproject.toml'), 'utf-8')).toContain(
      'version = "0.1.0"'
    )
    expect(await readFile(join(root, 'worker/transcriber_worker/__init__.py'), 'utf-8')).toContain(
      '__version__ = "0.1.0"'
    )
  })
})
