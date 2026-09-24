import { useEffect, useRef, useState } from 'react'
import { errorInfoOf } from '../errors'
import { useApi, useAppStore } from '../providers'

const COPIED_MS = 2000

/** Copia para a área de transferência e mostra "✓ Copiado" por 2 s; falha vira aviso. */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const api = useApi()
  const pushNotice = useAppStore((s) => s.pushNotice)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    []
  )

  const copy = async (text: string): Promise<void> => {
    try {
      await api.clipboard.write(text)
    } catch (error) {
      pushNotice({ kind: 'error', key: 'errors.INTERNAL', error: errorInfoOf(error) })
      return
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setCopied(false)
    }, COPIED_MS)
  }

  return { copied, copy }
}
