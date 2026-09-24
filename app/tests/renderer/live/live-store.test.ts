import { describe, expect, it } from 'vitest'
import { createAppStore } from '../../../src/renderer/src/store/app-store'
import { FakeApi } from '../fake-api'

async function ready() {
  const api = new FakeApi()
  const store = createAppStore(api)
  await store.getState().init()
  return { api, state: () => store.getState() }
}

describe('estado do ao vivo no store', () => {
  it('abre e fecha a tela do ao vivo', async () => {
    const { state } = await ready()
    state().openLive()
    expect(state().view).toBe('live')
    state().closeLive()
    expect(state().view).toBe('main')
  })

  it('acompanha a sessão: estado, trechos por faixa, ouvindo e atraso', async () => {
    const { api, state } = await ready()
    expect(state().liveSession).toMatchObject({ state: 'idle', segments: [], lag: 0 })
    api.emitLive({ type: 'state', state: 'starting', test: false, itemId: null })
    api.emitLive({ type: 'state', state: 'recording', test: false, itemId: 'i1' })
    api.emitLive({ type: 'listening', track: 'voce', active: true })
    api.emitLive({ type: 'segment', track: 'outros', start: 1, end: 2, text: 'Oi' })
    api.emitLive({ type: 'lag', seconds: 4 })
    expect(state().liveSession).toEqual({
      state: 'recording',
      test: false,
      itemId: 'i1',
      segments: [{ track: 'outros', start: 1, end: 2, text: 'Oi' }],
      listening: { voce: true, outros: false },
      lag: 4
    })
  })

  it('uma sessão nova começa limpa; ao encerrar o texto fica (preview do teste)', async () => {
    const { api, state } = await ready()
    api.emitLive({ type: 'state', state: 'recording', test: true, itemId: null })
    api.emitLive({ type: 'segment', track: 'voce', start: 0, end: 1, text: 'Teste' })
    api.emitLive({ type: 'listening', track: 'voce', active: true })
    api.emitLive({ type: 'lag', seconds: 5 })
    api.emitLive({ type: 'state', state: 'idle', test: true, itemId: null })
    expect(state().liveSession.segments).toHaveLength(1)
    expect(state().liveSession).toMatchObject({ listening: { voce: false }, lag: 0 })
    api.emitLive({ type: 'state', state: 'starting', test: false, itemId: null })
    expect(state().liveSession.segments).toEqual([])
  })

  it('erro do ao vivo vira aviso traduzido', async () => {
    const { api, state } = await ready()
    api.emitLive({ type: 'error', code: 'DISK_FULL' })
    expect(state().notices).toMatchObject([
      { kind: 'error', key: 'errors.DISK_FULL', error: { code: 'DISK_FULL' } }
    ])
  })
})
