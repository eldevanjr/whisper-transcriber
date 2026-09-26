import { createContext, useContext, type ReactNode } from 'react'
import { useLiveCapture, type LiveController } from '../hooks/useLiveCapture'

const LiveControllerContext = createContext<LiveController | null>(null)

/** O ao vivo pertence ao app, não à tela: a bandeja começa e para com a janela escondida. */
export function LiveCaptureProvider({ children }: { children: ReactNode }) {
  const controller = useLiveCapture()
  return <LiveControllerContext value={controller}>{children}</LiveControllerContext>
}

export function useLiveController(): LiveController {
  const controller = useContext(LiveControllerContext)
  if (controller === null) throw new Error('useLiveController usado fora do LiveCaptureProvider')
  return controller
}
