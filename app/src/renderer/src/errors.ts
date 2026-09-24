import { isErrorCode, type ErrorCode, type ErrorInfo } from '../../shared/errors'
import type { SettingsSection } from './store/app-store'

function field(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined
}

/**
 * O preload rejeita com o objeto simples `{ code, message, detail }` vindo do main
 * (o contextBridge não preservaria essas propriedades num Error). O resto vira INTERNAL.
 */
export function errorInfoOf(error: unknown): ErrorInfo {
  const code = field(error, 'code')
  const rawMessage = field(error, 'message')
  const detail = field(error, 'detail')
  const isObject = typeof error === 'object' && error !== null
  const message =
    typeof rawMessage === 'string'
      ? rawMessage
      : isObject
        ? ''
        : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- objetos já tratados acima
          String(error)
  if (!isErrorCode(code)) return { code: 'INTERNAL', message }
  return typeof detail === 'string' ? { code, message, detail } : { code, message }
}

export interface ErrorAction {
  key: string
  section: SettingsSection
}

const ACTIONS: Partial<Record<ErrorCode, ErrorAction>> = {
  OUT_OF_MEMORY: { key: 'errors.actions.smallerModel', section: 'transcription' },
  MODEL_LOAD_FAILED: { key: 'errors.actions.downloadModel', section: 'transcription' },
  CUDA_FAILED: { key: 'errors.actions.reinstallCuda', section: 'transcription' },
  CUDA_UNAVAILABLE: { key: 'errors.actions.reinstallCuda', section: 'transcription' },
  DISK_FULL: { key: 'errors.actions.storage', section: 'storage' },
  INSUFFICIENT_SPACE: { key: 'errors.actions.storage', section: 'storage' }
}

export function errorAction(code: ErrorCode): ErrorAction | null {
  return ACTIONS[code] ?? null
}
