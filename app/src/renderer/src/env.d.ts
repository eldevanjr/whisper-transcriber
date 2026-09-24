import type { TranscriberApi } from '../../shared/ipc'

declare global {
  interface Window {
    transcriber: TranscriberApi
  }
}
