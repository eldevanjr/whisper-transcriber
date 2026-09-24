export const WORKER_ERROR_CODES = [
  'INVALID_MESSAGE',
  'MODEL_NOT_LOADED',
  'MODEL_LOAD_FAILED',
  'OUT_OF_MEMORY',
  'CUDA_UNAVAILABLE',
  'CUDA_FAILED',
  'GPU_FAILED',
  'INVALID_MEDIA',
  'NO_AUDIO',
  'FILE_NOT_FOUND',
  'DISK_FULL',
  'INTERNAL'
] as const

export const APP_ERROR_CODES = [
  'WORKER_CRASHED',
  'WORKER_UNAVAILABLE',
  'WORKER_TIMEOUT',
  'PROTOCOL_MISMATCH',
  'CANCELED',
  'UNSUPPORTED_FILE',
  'DOWNLOAD_FAILED',
  'HASH_MISMATCH',
  'INSUFFICIENT_SPACE',
  'HOST_NOT_ALLOWED',
  'INVALID_REQUEST',
  'NOT_FOUND'
] as const

export type ErrorCode = (typeof WORKER_ERROR_CODES)[number] | (typeof APP_ERROR_CODES)[number]

export const ERROR_CODES: readonly ErrorCode[] = [...WORKER_ERROR_CODES, ...APP_ERROR_CODES]

const KNOWN: ReadonlySet<string> = new Set(ERROR_CODES)

export interface ErrorInfo {
  code: ErrorCode
  message: string
  detail?: string
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail: string | undefined

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }

  toInfo(): ErrorInfo {
    const info: ErrorInfo = { code: this.code, message: this.message }
    if (this.detail !== undefined) info.detail = this.detail
    return info
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value)
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new AppError('INTERNAL', message)
}
