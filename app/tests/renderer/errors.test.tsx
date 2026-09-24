import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorNotice } from '../../src/renderer/src/components/ErrorNotice'
import { Toasts } from '../../src/renderer/src/components/Toasts'
import { errorAction, errorInfoOf } from '../../src/renderer/src/errors'
import { ERROR_CODES } from '../../src/shared/errors'
import { RESOURCES } from '../../src/renderer/src/i18n'
import { apiError, FakeApi } from './fake-api'
import { expectAccessible, renderWithApp } from './render'

describe('errorInfoOf', () => {
  it('lê o objeto que a ponte entrega (formato real do preload)', () => {
    expect(errorInfoOf({ code: 'DISK_FULL', message: 'cheio', detail: 'd' })).toEqual({
      code: 'DISK_FULL',
      message: 'cheio',
      detail: 'd'
    })
    expect(errorInfoOf({ code: 'OUTRO', message: 'm' })).toEqual({ code: 'INTERNAL', message: 'm' })
    expect(errorInfoOf({ code: 'NO_AUDIO' })).toEqual({ code: 'NO_AUDIO', message: '' })
    expect(errorInfoOf(null)).toEqual({ code: 'INTERNAL', message: 'null' })
  })

  it('lê código e detalhe do erro do preload; o resto vira INTERNAL', () => {
    expect(errorInfoOf(Object.assign(new Error('m'), { code: 'NO_AUDIO', detail: 'd' }))).toEqual({
      code: 'NO_AUDIO',
      message: 'm',
      detail: 'd'
    })
    expect(errorInfoOf(apiError('DISK_FULL', 'cheio'))).toMatchObject({
      code: 'DISK_FULL',
      message: 'cheio'
    })
    expect(errorInfoOf(Object.assign(new Error('x'), { code: 'OUTRO' }))).toEqual({
      code: 'INTERNAL',
      message: 'x'
    })
    expect(errorInfoOf('texto')).toEqual({ code: 'INTERNAL', message: 'texto' })
  })
})

describe('errorAction', () => {
  it('sugere o caminho certo para cada tipo de erro', () => {
    expect(errorAction('OUT_OF_MEMORY')).toEqual({
      key: 'errors.actions.smallerModel',
      section: 'transcription'
    })
    expect(errorAction('CUDA_FAILED')?.key).toBe('errors.actions.reinstallCuda')
    expect(errorAction('CUDA_UNAVAILABLE')?.key).toBe('errors.actions.reinstallCuda')
    expect(errorAction('DISK_FULL')).toEqual({ key: 'errors.actions.storage', section: 'storage' })
    expect(errorAction('INSUFFICIENT_SPACE')?.section).toBe('storage')
    expect(errorAction('MODEL_LOAD_FAILED')?.key).toBe('errors.actions.downloadModel')
    expect(errorAction('NO_AUDIO')).toBeNull()
  })

  it('todo código de erro tem mensagem traduzida', () => {
    for (const code of ERROR_CODES) {
      expect(RESOURCES['pt-BR'].translation.errors).toHaveProperty(code)
    }
  })
})

describe('ErrorNotice', () => {
  it('mensagem simples, ação, detalhes recolhidos e cópia do diagnóstico sem caminhos pessoais', async () => {
    const { user, api, store, container } = await renderWithApp(
      <ErrorNotice
        error={{ code: 'OUT_OF_MEMORY', message: 'oom', detail: '/home/ana/modelo: sem memória' }}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent('A memória acabou')
    expect(screen.getByText('Detalhes técnicos')).toBeInTheDocument()
    expect(screen.getByText(/OUT_OF_MEMORY: oom/)).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Copiar diagnóstico' }))
    expect(api.clipboard.write).toHaveBeenCalledWith(expect.stringContaining('~/modelo'))
    expect(api.clipboard.write).toHaveBeenCalledWith(expect.not.stringContaining('ana'))
    expect(await screen.findByText('✓ Copiado')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Relatar problema' }))
    const issue = new URL(api.system.openExternal.mock.calls[0]![0])
    expect(issue.pathname).toBe('/eldevanjr/whisper-transcriber/issues/new')
    expect(issue.searchParams.get('title')).toBe('OUT_OF_MEMORY: oom')
    expect(issue.searchParams.get('body')).toContain('~/modelo')
    await user.click(screen.getByRole('button', { name: 'Usar um modelo menor' }))
    expect(store.getState()).toMatchObject({ view: 'settings', settingsSection: 'transcription' })
    await expectAccessible(container)
  })

  it('sem detalhe, sem ação e com ações extras do chamador', async () => {
    await renderWithApp(
      <ErrorNotice
        error={{ code: 'NO_AUDIO', message: 'sem áudio' }}
        actions={<button type="button">Remover</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Remover' })).toBeInTheDocument()
    expect(screen.getByText('NO_AUDIO: sem áudio')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /modelo menor/ })).not.toBeInTheDocument()
  })

  it('"✓ Copiado" some depois de 2 s; falha ao copiar vira aviso', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = new FakeApi()
    const { store } = await renderWithApp(
      <ErrorNotice error={{ code: 'INTERNAL', message: 'x' }} />,
      {
        api
      }
    )
    await act(async () => {
      screen.getByRole('button', { name: 'Copiar diagnóstico' }).click()
      await Promise.resolve()
    })
    expect(screen.getByText('✓ Copiado')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByText('✓ Copiado')).not.toBeInTheDocument()
    api.clipboard.write.mockRejectedValueOnce(apiError('INTERNAL', 'sem clipboard'))
    await act(async () => {
      screen.getByRole('button', { name: 'Copiar diagnóstico' }).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(store.getState().notices).toMatchObject([
      { kind: 'error', error: { message: 'sem clipboard' } }
    ])
    vi.useRealTimers()
  })
})

describe('Toasts', () => {
  it('mostra avisos, dispensa no botão e some sozinho depois de 6 s se for informativo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { store } = await renderWithApp(<Toasts />)
    act(() => {
      store.getState().pushNotice({ kind: 'info', key: 'notices.cudaFallback' })
      store.getState().pushNotice({
        kind: 'error',
        key: 'notices.rejected',
        values: { names: 'a.pdf' },
        error: { code: 'UNSUPPORTED_FILE', message: 'x' }
      })
    })
    expect(screen.getByText(/esta transcrição seguiu na CPU/)).toBeInTheDocument()
    expect(screen.getByText('Não suportado ou não encontrado: a.pdf')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.queryByText(/seguiu na CPU/)).not.toBeInTheDocument()
    expect(screen.getByText(/a\.pdf/)).toBeInTheDocument()
    act(() => {
      screen.getByRole('button', { name: 'Dispensar aviso' }).click()
    })
    expect(store.getState().notices).toEqual([])
    vi.useRealTimers()
  })
})
