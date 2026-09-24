export const MODEL_IDS = ['small', 'medium', 'large-v3-turbo', 'large-v3'] as const
export type ModelId = (typeof MODEL_IDS)[number]

/** ct2 = CTranslate2 (faster-whisper: CPU e CUDA); ggml = whisper.cpp (GPU Vulkan/Metal). */
export const MODEL_FORMATS = ['ct2', 'ggml'] as const
export type ModelFormat = (typeof MODEL_FORMATS)[number]

export function formatForDevice(device: 'cpu' | 'cuda' | 'gpu'): ModelFormat {
  return device === 'gpu' ? 'ggml' : 'ct2'
}

type Level = 1 | 2 | 3 | 4

export interface ModelInfo {
  id: ModelId
  label: string
  speed: Level
  accuracy: Level
}

export const MODEL_CATALOG: Readonly<Record<ModelId, ModelInfo>> = {
  small: { id: 'small', label: 'Small', speed: 4, accuracy: 2 },
  medium: { id: 'medium', label: 'Medium', speed: 3, accuracy: 3 },
  'large-v3-turbo': { id: 'large-v3-turbo', label: 'Large v3 Turbo', speed: 3, accuracy: 4 },
  'large-v3': { id: 'large-v3', label: 'Large v3', speed: 1, accuracy: 4 }
}

export const LOW_RAM_BYTES = 8 * 1024 ** 3

export function recommendModel(input: { ramBytes: number; hasNvidiaGpu: boolean }): ModelId {
  if (input.ramBytes < LOW_RAM_BYTES) return 'small'
  return input.hasNvidiaGpu ? 'large-v3-turbo' : 'medium'
}
