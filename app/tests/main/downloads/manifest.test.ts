import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cudaSize,
  cudaTarget,
  isAllowedHost,
  modelFileUrl,
  modelSize,
  parseManifest,
  type Manifest
} from '../../../src/main/downloads/manifest'
import { MODEL_IDS } from '../../../src/shared/models'

const real = (): Manifest =>
  parseManifest(
    JSON.parse(readFileSync(join(__dirname, '../../../resources/downloads-manifest.json'), 'utf8'))
  )

describe('manifesto versionado', () => {
  it('é válido e cobre todos os modelos e alvos CUDA', () => {
    const manifest = real()
    expect(Object.keys(manifest.models).sort()).toEqual([...MODEL_IDS].sort())
    for (const id of MODEL_IDS) {
      const paths = manifest.models[id].files.map((f) => f.path)
      expect(paths).toContain('model.bin')
      expect(paths).toContain('config.json')
    }
    for (const id of MODEL_IDS) {
      expect(manifest.ggml[id].repo).toBe('ggerganov/whisper.cpp')
      expect(manifest.ggml[id].files.map((f) => f.path)).toEqual([`ggml-${id}.bin`])
    }
    expect(manifest.cuda['win32-x64'].length).toBeGreaterThanOrEqual(2)
    expect(
      manifest.cuda['linux-x64'].every((w) => w.url.startsWith('https://files.pythonhosted.org/'))
    ).toBe(true)
  })

  it('rejeita manifesto adulterado', () => {
    const manifest = real()
    const tampered = structuredClone(manifest) as unknown as {
      models: { small: { files: { sha256: string; path: string }[] } }
    }
    tampered.models.small.files[0]!.sha256 = 'xyz'
    expect(() => parseManifest(tampered)).toThrow()
    const traversal = structuredClone(manifest) as unknown as typeof tampered
    traversal.models.small.files[0]!.path = '../../evil.bin'
    expect(() => parseManifest(traversal)).toThrow()
  })
})

describe('helpers do manifesto', () => {
  const model = {
    repo: 'Systran/faster-whisper-small',
    revision: 'a'.repeat(40),
    files: [
      { path: 'model.bin', size: 10, sha256: 'b'.repeat(64) },
      { path: 'config.json', size: 5, sha256: 'c'.repeat(64) }
    ]
  }

  it('modelFileUrl aponta para a revisão fixada', () => {
    expect(modelFileUrl(model, model.files[0]!)).toBe(
      `https://huggingface.co/Systran/faster-whisper-small/resolve/${'a'.repeat(40)}/model.bin`
    )
  })

  it('somas de tamanho', () => {
    expect(modelSize(model)).toBe(15)
    expect(cudaSize([{ name: 'a.whl', url: 'https://x', size: 3, sha256: 'd'.repeat(64) }])).toBe(3)
  })

  it.each([
    ['win32', 'x64', 'win32-x64'],
    ['linux', 'x64', 'linux-x64'],
    ['darwin', 'arm64', null],
    ['linux', 'arm64', null]
  ])('cudaTarget(%s, %s) = %s', (platform, arch, expected) => {
    expect(cudaTarget(platform, arch)).toBe(expected)
  })

  it.each([
    ['huggingface.co', true],
    ['cdn-lfs.huggingface.co', true],
    ['cas-bridge.xethub.hf.co', true],
    ['files.pythonhosted.org', true],
    ['pypi.org', true],
    ['api.github.com', true],
    ['HUGGINGFACE.CO', true],
    ['evilhuggingface.co', false],
    ['huggingface.co.evil.com', false],
    ['github.com', false],
    ['example.com', false]
  ])('isAllowedHost(%s) = %s', (host, expected) => {
    expect(isAllowedHost(host)).toBe(expected)
  })
})
