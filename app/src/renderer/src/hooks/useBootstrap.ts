import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveLanguage } from '../i18n'
import { useAppStore } from '../providers'

/** Carrega o estado do main uma vez, mantém os eventos ligados e o idioma da interface em dia. */
export function useBootstrap(): boolean {
  const init = useAppStore((s) => s.init)
  const ready = useAppStore((s) => s.ready)
  const uiLanguage = useAppStore((s) => s.settings?.uiLanguage ?? null)
  const { i18n } = useTranslation()

  useEffect(() => {
    let stop: (() => void) | null = null
    let active = true
    void init().then((unsubscribe) => {
      if (active) stop = unsubscribe
      else unsubscribe()
    })
    return () => {
      active = false
      stop?.()
    }
  }, [init])

  useEffect(() => {
    const language = resolveLanguage(uiLanguage, navigator.language)
    void i18n.changeLanguage(language)
    document.documentElement.lang = language
  }, [i18n, uiLanguage])

  return ready
}
