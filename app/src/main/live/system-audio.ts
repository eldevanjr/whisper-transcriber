/**
 * Áudio do sistema ("Outros" no ao vivo): o que cada plataforma oferece.
 * - Windows: loopback nativo do Electron (getDisplayMedia + setDisplayMediaRequestHandler).
 * - macOS ≥ 14.2 (Darwin 23.2): o mesmo caminho com a feature MacLoopbackAudioForScreenShare.
 * - Linux: o "Monitor of …" do PipeWire/PulseAudio aparece como uma entrada de áudio comum.
 */
export type SystemAudioSupport = 'loopback' | 'monitor' | 'unavailable'

export const MAC_LOOPBACK_FEATURE = 'MacLoopbackAudioForScreenShare'

export function systemAudioSupport(platform: string, osRelease: string): SystemAudioSupport {
  if (platform === 'win32') return 'loopback'
  if (platform === 'linux') return 'monitor'
  if (platform !== 'darwin') return 'unavailable'
  const [major = 0, minor = 0] = osRelease.split('.').map(Number)
  return major > 23 || (major === 23 && minor >= 2) ? 'loopback' : 'unavailable'
}

interface ScreenSource {
  id: string
  name: string
}

type GetSources = (options: { types: ['screen'] }) => Promise<ScreenSource[]>
interface Streams {
  video?: ScreenSource
  audio?: 'loopback'
}

/** Pedido de captura do app: a primeira tela (o vídeo é descartado) com o áudio do sistema. */
export function displayMediaHandler(getSources: GetSources) {
  return async (_request: unknown, callback: (streams: Streams) => void): Promise<void> => {
    try {
      const [screen] = await getSources({ types: ['screen'] })
      callback(screen ? { video: screen, audio: 'loopback' } : {})
    } catch {
      callback({})
    }
  }
}

/** Permissões do renderer: só áudio (microfone) e a captura usada para o áudio do sistema. */
export function allowPermission(
  permission: string,
  details: { mediaTypes?: string[]; mediaType?: string }
): boolean {
  if (permission === 'display-capture') return true
  if (permission !== 'media') return false
  const types = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : [])
  return types.length > 0 && types.every((type) => type === 'audio')
}
