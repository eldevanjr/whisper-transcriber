import { describe, expect, it } from 'vitest'
import { readDevOverrides } from '../../src/main/dev-overrides'

describe('readDevOverrides', () => {
  const env = {
    WT_WORKER_COMMAND: JSON.stringify({ command: '/usr/bin/node', args: ['e2e/fake-worker.mjs'] }),
    WT_DOWNLOADS_MANIFEST: '/tmp/manifest.json'
  }

  it('em desenvolvimento aceita o motor falso e o manifesto de teste (E2E)', () => {
    expect(readDevOverrides(env, false)).toEqual({
      workerCommand: { command: '/usr/bin/node', args: ['e2e/fake-worker.mjs'] },
      manifestPath: '/tmp/manifest.json'
    })
  })

  it('no app empacotado ignora tudo (ninguém troca o motor por variável de ambiente)', () => {
    expect(readDevOverrides(env, true)).toEqual({})
  })

  it('sem variáveis ou com JSON inválido, nada muda', () => {
    expect(readDevOverrides({}, false)).toEqual({})
    expect(readDevOverrides({ WT_WORKER_COMMAND: '{quebrado' }, false)).toEqual({})
    expect(readDevOverrides({ WT_WORKER_COMMAND: '{"command":1}' }, false)).toEqual({})
  })
})
