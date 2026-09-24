import type { ErrorCode, ErrorInfo } from './errors'
import type { HistoryMeta, Segment } from './history'
import type { ModelFormat, ModelId } from './models'
import type { Device, Track } from './settings'

export const PHASES = ['loading_model', 'extracting_audio', 'transcribing'] as const
export type Phase = (typeof PHASES)[number]

/** Refazer do ao vivo: qual faixa está sendo transcrita (uma depois da outra). */
export interface TrackPass {
  track: Track
  index: number
  count: number
}

export type QueueEvent =
  | { type: 'job'; meta: HistoryMeta }
  | { type: 'removed'; jobId: string }
  | { type: 'phase'; jobId: string; phase: Phase }
  | {
      type: 'progress'
      jobId: string
      pct: number
      /** Da faixa em andamento (refazer do ao vivo: uma faixa por vez) ou do arquivo. */
      processedS: number
      totalS: number
      speed: number
      pass?: TrackPass
    }
  | { type: 'segment'; jobId: string; segment: Segment }
  | { type: 'notice'; jobId: string; code: 'CUDA_FALLBACK' }

export type DownloadTarget = { kind: 'model'; id: ModelId; format?: ModelFormat } | { kind: 'cuda' }

/** Chave estável de um download (o formato ct2 mantém a chave antiga, "model:<id>"). */
export function downloadKey(target: DownloadTarget): string {
  if (target.kind === 'cuda') return 'cuda'
  return target.format === 'ggml' ? `model-ggml:${target.id}` : `model:${target.id}`
}

export type DownloadEvent =
  | { type: 'progress'; target: DownloadTarget; received: number; total: number }
  | { type: 'done'; target: DownloadTarget }
  | { type: 'canceled'; target: DownloadTarget }
  | { type: 'failed'; target: DownloadTarget; error: ErrorInfo }

export interface GpuInfo {
  name: string
  memoryMb: number
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'

/** GPU usada pelo whisper.cpp: Vulkan (Windows/Linux) ou Metal (Apple Silicon). */
export interface Accelerator {
  name: string
  api: 'vulkan' | 'metal'
}

export interface SystemInfo {
  platform: string
  arch: string
  ramBytes: number
  /** GPU NVIDIA (nvidia-smi), para o caminho CUDA do faster-whisper. */
  gpu: GpuInfo | null
  cudaSupported: boolean
  accelerator: Accelerator | null
  recommendedDevice: Device
  recommendedModel: ModelId
}

export interface UpdateInfo {
  available: boolean
  latest: string
  url: string
  /** auto: o electron-updater baixa e instala (Windows NSIS, AppImage); link: abre a release. */
  mode: 'auto' | 'link'
}

/** A atualização baixada pelo electron-updater está pronta para instalar. */
export interface UpdateEvent {
  type: 'ready'
  version: string
}

export interface QueueState {
  current: string | null
  pending: string[]
}

export interface EnqueueResult {
  accepted: HistoryMeta[]
  rejected: string[]
}

/** Estado da sessão ao vivo (a tela mostra REC, pausa, encerrando). */
export type LiveState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'

export type LiveEvent =
  | { type: 'state'; state: LiveState; test: boolean; itemId: string | null }
  | { type: 'segment'; track: Track; start: number; end: number; text: string }
  | { type: 'listening'; track: Track; active: boolean }
  | { type: 'lag'; seconds: number }
  | { type: 'error'; code: ErrorCode }
