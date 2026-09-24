import { describe, expect, it, vi } from 'vitest'
import { createAppStore, selectEntries, targetKey } from '../../src/renderer/src/store/app-store'
import { APP_INFO, FakeApi, makeMeta, SYSTEM_INFO } from './fake-api'

async function ready(api = new FakeApi()) {
  const store = createAppStore(api)
  const stop = await store.getState().init()
  return { api, store, stop, state: () => store.getState() }
}

describe('createAppStore', () => {
  it('init carrega configurações, app, sistema, fila e histórico', async () => {
    const api = new FakeApi()
    const done = makeMeta()
    api.entries = [done]
    api.corrupted = ['quebrado']
    const { state } = await ready(api)
    expect(state()).toMatchObject({
      ready: true,
      settings: { model: 'medium' },
      appInfo: APP_INFO,
      systemInfo: SYSTEM_INFO,
      queue: { current: null, pending: [] },
      corrupted: ['quebrado'],
      selectedId: null
    })
    expect(state().entries[done.id]).toEqual(done)
  })

  it('o unsubscribe devolvido por init remove todos os ouvintes', async () => {
    const { api, stop } = await ready()
    expect(api.listenerCount()).toBe(4)
    stop()
    expect(api.listenerCount()).toBe(0)
  })

  it('reidrata o job em andamento com os trechos já gravados (tela recarregada)', async () => {
    const api = new FakeApi()
    const job = makeMeta({ status: 'processing' })
    api.entries = [job]
    api.current = job.id
    api.details.set(job.id, {
      meta: job,
      transcript: [{ inicio: 0, fim: 1, texto: 'já veio' }],
      videoAvailable: true,
      hasRedo: false
    })
    const { state } = await ready(api)
    expect(state().queue.current).toBe(job.id)
    expect(state().selectedId).toBe(job.id)
    expect(state().live[job.id]?.segments).toEqual([{ start: 0, end: 1, text: 'já veio' }])
  })

  it('progresso sem fase conhecida (tela recarregada no meio) mostra "transcrevendo"', async () => {
    const { api, state } = await ready()
    api.emitQueue({ type: 'progress', jobId: 'j', pct: 10, processedS: 1, totalS: 10, speed: 1 })
    expect(state().live.j?.phase).toBe('transcribing')
    api.emitQueue({ type: 'phase', jobId: 'j', phase: 'extracting_audio' })
    api.emitQueue({ type: 'progress', jobId: 'j', pct: 20, processedS: 2, totalS: 10, speed: 1 })
    expect(state().live.j?.phase).toBe('extracting_audio')
  })

  it('nova fase zera o progresso: a transcrição não começa com a barra da extração cheia', async () => {
    const { api, state } = await ready()
    api.emitQueue({ type: 'phase', jobId: 'j', phase: 'extracting_audio' })
    api.emitQueue({ type: 'progress', jobId: 'j', pct: 100, processedS: 60, totalS: 60, speed: 9 })
    expect(state().live.j?.progress?.pct).toBe(100)
    api.emitQueue({ type: 'phase', jobId: 'j', phase: 'transcribing' })
    expect(state().live.j?.progress).toBeNull()
  })

  it('eventos que chegam durante a carga não se perdem e se juntam ao parcial', async () => {
    const api = new FakeApi()
    const job = makeMeta({ status: 'processing' })
    api.entries = [job]
    api.current = job.id
    let release: () => void = () => undefined
    api.details.set(job.id, {
      meta: job,
      transcript: [
        { inicio: 0, fim: 1, texto: 'a' },
        { inicio: 1, fim: 2, texto: 'b' }
      ],
      videoAvailable: true,
      hasRedo: false
    })
    const get = api.history.get.getMockImplementation()!
    api.history.get.mockImplementation(
      (id: string) => new Promise((resolve) => (release = () => void get(id).then(resolve)))
    )
    const store = createAppStore(api)
    const init = store.getState().init()
    await vi.waitFor(() => {
      expect(api.history.get).toHaveBeenCalled()
    })
    api.emitQueue({ type: 'segment', jobId: job.id, segment: { start: 1, end: 2, text: 'b' } })
    api.emitQueue({ type: 'segment', jobId: job.id, segment: { start: 2, end: 3, text: 'c' } })
    release()
    await init
    expect(store.getState().live[job.id]?.segments.map((s) => s.text)).toEqual(['a', 'b', 'c'])
  })

  it('reidratação que falha não impede a carga', async () => {
    const api = new FakeApi()
    api.current = '00000000-0000-4000-8000-999999999999' // sem entrada: history.get rejeita
    const { state } = await ready(api)
    expect(state().ready).toBe(true)
    expect(state().live).toEqual({})
  })

  it('eventos de job mantêm fila, atual e seleção', async () => {
    const { api, state } = await ready()
    const a = makeMeta({ status: 'queued' })
    const b = makeMeta({ status: 'queued' })
    api.emitQueue({ type: 'job', meta: a })
    api.emitQueue({ type: 'job', meta: b })
    expect(state().queue).toEqual({ current: null, pending: [a.id, b.id] })
    api.emitQueue({ type: 'job', meta: { ...a, status: 'processing' } })
    expect(state().queue).toEqual({ current: a.id, pending: [b.id] })
    expect(state().selectedId).toBe(a.id)
    expect(state().live[a.id]).toEqual({ phase: null, progress: null, segments: [] })
    api.emitQueue({ type: 'phase', jobId: a.id, phase: 'transcribing' })
    api.emitQueue({
      type: 'progress',
      jobId: a.id,
      pct: 50,
      processedS: 10,
      totalS: 20,
      speed: 2
    })
    api.emitQueue({ type: 'segment', jobId: a.id, segment: { start: 0, end: 1, text: 'oi' } })
    expect(state().live[a.id]).toEqual({
      phase: 'transcribing',
      progress: { pct: 50, processedS: 10, totalS: 20, speed: 2, pass: null },
      segments: [{ start: 0, end: 1, text: 'oi' }]
    })
    api.emitQueue({ type: 'job', meta: { ...a, status: 'done' } })
    expect(state().queue.current).toBeNull()
    api.emitQueue({ type: 'job', meta: { ...b, status: 'processing' } })
    expect(state().selectedId).toBe(a.id) // o usuário está olhando o resultado de a
    api.emitQueue({ type: 'job', meta: { ...b, status: 'failed' } })
    expect(state().queue).toEqual({ current: null, pending: [] })
  })

  it('eventos ao vivo de um job desconhecido criam o estado dele', async () => {
    const { api, state } = await ready()
    api.emitQueue({ type: 'segment', jobId: 'x', segment: { start: 0, end: 1, text: 'a' } })
    expect(state().live.x?.segments).toHaveLength(1)
  })

  it('removed apaga a entrada, tira da fila e da seleção; notice vira aviso', async () => {
    const { api, state, store } = await ready()
    const a = makeMeta({ status: 'queued' })
    api.emitQueue({ type: 'job', meta: a })
    store.getState().select(a.id)
    api.emitQueue({ type: 'removed', jobId: a.id })
    expect(state().entries[a.id]).toBeUndefined()
    expect(state().queue.pending).toEqual([])
    expect(state().selectedId).toBeNull()
    api.corrupted = []
    const other = makeMeta()
    api.emitQueue({ type: 'job', meta: other })
    store.getState().select(other.id)
    api.emitQueue({ type: 'removed', jobId: 'quebrado' })
    expect(state().selectedId).toBe(other.id)
    api.emitQueue({ type: 'notice', jobId: a.id, code: 'CUDA_FALLBACK' })
    expect(state().notices).toMatchObject([{ kind: 'info', key: 'notices.cudaFallback' }])
  })

  it('removed também limpa corrompidos', async () => {
    const api = new FakeApi()
    api.corrupted = ['quebrado']
    const { state } = await ready(api)
    api.emitQueue({ type: 'removed', jobId: 'quebrado' })
    expect(state().corrupted).toEqual([])
  })

  it('downloads: progresso, conclusão, falha e cancelamento', async () => {
    const { api, state } = await ready()
    const target = { kind: 'model', id: 'small' } as const
    const key = targetKey(target)
    expect(key).toBe('model:small')
    expect(targetKey({ kind: 'cuda' })).toBe('cuda')
    api.emitDownload({ type: 'progress', target, received: 5, total: 10 })
    expect(state().downloads[key]).toMatchObject({ status: 'active', received: 5, total: 10 })
    expect(state().downloads[key]?.samples).toHaveLength(1)
    api.emitDownload({ type: 'done', target })
    expect(state().downloads[key]).toMatchObject({ status: 'done', received: 10 })
    const error = { code: 'DOWNLOAD_FAILED' as const, message: 'caiu' }
    api.emitDownload({ type: 'failed', target, error })
    expect(state().downloads[key]).toMatchObject({ status: 'failed', error })
    api.emitDownload({ type: 'canceled', target: { kind: 'cuda' } })
    expect(state().downloads.cuda).toEqual({
      status: 'canceled',
      received: 0,
      total: 0,
      samples: []
    })
    api.emitDownload({ type: 'progress', target, received: 1, total: 10 })
    expect(state().downloads[key]?.samples).toHaveLength(1) // recomeço depois da falha zera a média
  })

  it('configurações alteradas no main chegam ao store', async () => {
    const { api, state } = await ready()
    api.emitSettings({ theme: 'dark' })
    expect(state().settings?.theme).toBe('dark')
  })

  it('navegação e avisos', async () => {
    const { store, state } = await ready()
    store.getState().openSettings('about')
    expect(state()).toMatchObject({ view: 'settings', settingsSection: 'about' })
    store.getState().openSettings()
    expect(state().settingsSection).toBe('general')
    store.getState().closeSettings()
    expect(state().view).toBe('main')
    store.getState().pushNotice({ kind: 'error', key: 'x' })
    store.getState().pushNotice({ kind: 'info', key: 'y', values: { n: '2' } })
    const [first, second] = state().notices
    expect(second).toMatchObject({ key: 'y', values: { n: '2' } })
    store.getState().dismissNotice(first!.id)
    expect(state().notices.map((n) => n.key)).toEqual(['y'])
  })

  it('refreshHistory recarrega a lista; selectEntries ordena do mais novo', async () => {
    const api = new FakeApi()
    const { store, state } = await ready(api)
    const old = makeMeta()
    const recent = makeMeta()
    api.entries = [old, recent]
    await store.getState().refreshHistory()
    expect(selectEntries(state()).map((e) => e.id)).toEqual([recent.id, old.id])
  })

  it('onboarding: ligado quando ainda não há modelo e desligado ao terminar', async () => {
    const fresh = await ready(new FakeApi({ model: null }))
    expect(fresh.state().onboarding).toBe(true)
    fresh.api.emitSettings({ model: 'small' }) // modelo gravado no meio do onboarding
    expect(fresh.state().onboarding).toBe(true)
    fresh.store.getState().finishOnboarding()
    expect(fresh.state().onboarding).toBe(false)
    const configured = await ready()
    expect(configured.state().onboarding).toBe(false)
  })

  it('setSettings aplica o retorno de uma atualização', async () => {
    const { store, state } = await ready()
    store.getState().setSettings({ ...state().settings!, audioLanguage: 'en' })
    expect(state().settings?.audioLanguage).toBe('en')
  })
})
