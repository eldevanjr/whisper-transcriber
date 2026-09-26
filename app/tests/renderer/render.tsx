import { render, type RenderResult } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import axe from 'axe-core'
import type { i18n } from 'i18next'
import type { ReactNode } from 'react'
import { expect } from 'vitest'
import { createI18n, type UiLanguage } from '../../src/renderer/src/i18n'
import { LiveCaptureProvider } from '../../src/renderer/src/live/LiveCaptureProvider'
import { AppProviders } from '../../src/renderer/src/providers'
import { createAppStore, type AppStore } from '../../src/renderer/src/store/app-store'
import { FakeApi } from './fake-api'
import { FakeLiveMedia } from './fake-media'

export interface Rendered extends RenderResult {
  api: FakeApi
  media: FakeLiveMedia
  store: AppStore
  i18n: i18n
  user: UserEvent
}

export async function renderWithApp(
  ui: ReactNode,
  options: { api?: FakeApi; media?: FakeLiveMedia; init?: boolean; language?: UiLanguage } = {}
): Promise<Rendered> {
  const api = options.api ?? new FakeApi()
  const media = options.media ?? new FakeLiveMedia()
  const store = createAppStore(api)
  if (options.init !== false) await store.getState().init()
  const i18n = createI18n(options.language ?? 'pt-BR')
  const user = userEvent.setup()
  const wrap = (node: ReactNode) => (
    <AppProviders api={api} store={store} i18n={i18n} liveMedia={media}>
      <LiveCaptureProvider>{node}</LiveCaptureProvider>
    </AppProviders>
  )
  const result = render(wrap(ui))
  // rerender com os mesmos providers (store, api e i18n) do render inicial.
  const rerender = (node: ReactNode) => {
    result.rerender(wrap(node))
  }
  return { ...result, rerender, api, media, store, i18n, user }
}

/** axe-core no DOM renderizado (o jsdom não calcula cores: contraste fica para o E2E). */
export async function expectAccessible(container: Element): Promise<void> {
  const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
  const violations = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((node) => node.target.join(' ')).join(', ')}`
  )
  expect(violations).toEqual([])
}
