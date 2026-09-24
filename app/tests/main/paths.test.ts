import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appPaths, modelDir } from '../../src/main/paths'

describe('paths', () => {
  it('monta a árvore da pasta de dados', () => {
    const paths = appPaths('/u')
    expect(paths).toEqual({
      root: '/u',
      settings: join('/u', 'settings.json'),
      settingsBackup: join('/u', 'settings.bak.json'),
      models: join('/u', 'models'),
      modelsGgml: join('/u', 'models-ggml'),
      cuda: join('/u', 'cuda'),
      history: join('/u', 'history'),
      logs: join('/u', 'logs')
    })
    expect(modelDir(paths, 'medium')).toBe(join('/u', 'models', 'medium'))
    expect(modelDir(paths, 'medium', 'ggml')).toBe(join('/u', 'models-ggml', 'medium'))
  })
})
