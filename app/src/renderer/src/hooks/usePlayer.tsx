import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

export interface PlayerControls {
  currentTime: number
  seek: (seconds: number) => void
  /** Acompanha a transcrição: move um vídeo pausado, sem tocar, até o usuário dar play. */
  follow: (seconds: number) => void
  attach: (element: HTMLMediaElement | null) => (() => void) | undefined
}

const PlayerContext = createContext<PlayerControls | null>(null)
const FOLLOW_STEP_S = 1

/** Liga o <video>/<audio> aos trechos: tempo atual para destacar e seek ao clicar. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const element = useRef<HTMLMediaElement | null>(null)
  // O usuário deu play neste elemento: daí em diante a posição é dele.
  const userControl = useRef(false)
  const [currentTime, setCurrentTime] = useState(0)

  // Ref callback com limpeza (React 19): liga o timeupdate enquanto o elemento existir.
  const attach = useCallback((media: HTMLMediaElement | null) => {
    element.current = media
    userControl.current = false
    if (!media) return undefined
    const onTime = (): void => {
      setCurrentTime(media.currentTime)
    }
    const onPlay = (): void => {
      userControl.current = true
    }
    media.addEventListener('timeupdate', onTime)
    media.addEventListener('play', onPlay)
    return () => {
      media.removeEventListener('timeupdate', onTime)
      media.removeEventListener('play', onPlay)
      element.current = null
    }
  }, [])

  const seek = useCallback((seconds: number) => {
    if (element.current) element.current.currentTime = seconds
    setCurrentTime(seconds)
  }, [])

  const follow = useCallback((seconds: number) => {
    const media = element.current
    if (!media || userControl.current || !media.paused) return
    // Menos de 1 s de diferença não vale um novo quadro (e evita pulos a cada progresso).
    if (Math.abs(media.currentTime - seconds) >= FOLLOW_STEP_S) media.currentTime = seconds
  }, [])

  const value = useMemo(
    () => ({ currentTime, seek, follow, attach }),
    [currentTime, seek, follow, attach]
  )
  return <PlayerContext value={value}>{children}</PlayerContext>
}

export function usePlayer(): PlayerControls {
  const player = useContext(PlayerContext)
  if (!player) throw new Error('usePlayer usado fora do PlayerProvider')
  return player
}
