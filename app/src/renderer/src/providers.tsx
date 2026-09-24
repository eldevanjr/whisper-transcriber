import type { i18n } from 'i18next'
import { createContext, useContext, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { useStore } from 'zustand'
import type { TranscriberApi } from '../../shared/ipc'
import type { AppActions, AppState, AppStore } from './store/app-store'

const ApiContext = createContext<TranscriberApi | null>(null)
const StoreContext = createContext<AppStore | null>(null)

export function AppProviders(props: {
  api: TranscriberApi
  store: AppStore
  i18n: i18n
  children: ReactNode
}) {
  return (
    <ApiContext value={props.api}>
      <StoreContext value={props.store}>
        <I18nextProvider i18n={props.i18n}>{props.children}</I18nextProvider>
      </StoreContext>
    </ApiContext>
  )
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`${name} usado fora do AppProviders`)
  return value
}

export function useApi(): TranscriberApi {
  return required(useContext(ApiContext), 'useApi')
}

export function useAppStore<T>(selector: (state: AppState & AppActions) => T): T {
  return useStore(required(useContext(StoreContext), 'useAppStore'), selector)
}
