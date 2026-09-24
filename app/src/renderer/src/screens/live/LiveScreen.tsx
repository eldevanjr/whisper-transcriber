import { useLiveCapture } from '../../hooks/useLiveCapture'
import { useAppStore } from '../../providers'
import { LiveSession } from './LiveSession'
import { LiveSetup } from './LiveSetup'

/** Tela do ao vivo: preparar e testar até começar; a sessão enquanto grava. A captura é uma só. */
export function LiveScreen() {
  const controller = useLiveCapture()
  const inSession = useAppStore((s) => s.liveSession.state !== 'idle' && !s.liveSession.test)
  return inSession ? <LiveSession controller={controller} /> : <LiveSetup controller={controller} />
}
