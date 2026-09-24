import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useApi } from '../providers'

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

/** Arrastar arquivos em qualquer lugar da janela; devolve se há algo sendo arrastado. */
export function useDropFiles(onPaths: (paths: string[]) => void): boolean {
  const api = useApi()
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const deliver = useEffectEvent(onPaths)

  useEffect(() => {
    const onEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth.current += 1
      setDragging(true)
    }
    const onOver = (event: DragEvent): void => {
      event.preventDefault() // sem isso o Chromium abre o arquivo em vez de soltar
    }
    const onLeave = (): void => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) deliver(files.map((file) => api.files.pathFor(file)))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [api])

  return dragging
}
