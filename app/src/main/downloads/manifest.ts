import { z } from 'zod'
import type { ModelId } from '../../shared/models'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Size = z.number().int().positive()

const FileSchema = z.object({ path: z.string().regex(/^[\w.-]+$/), size: Size, sha256: Sha256 })
const ModelSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(FileSchema).min(1)
})
const WheelSchema = z.object({
  name: z.string().regex(/^[\w.-]+\.whl$/),
  url: z.string().startsWith('https://'),
  size: Size,
  sha256: Sha256
})

export const CUDA_TARGETS = ['win32-x64', 'linux-x64'] as const
export type CudaTarget = (typeof CUDA_TARGETS)[number]

export const ManifestSchema = z.object({
  version: z.literal(1),
  models: z.object({
    small: ModelSchema,
    medium: ModelSchema,
    'large-v3-turbo': ModelSchema,
    'large-v3': ModelSchema
  }),
  // whisper.cpp (GPU Vulkan/Metal): um arquivo ggml-<modelo>.bin por modelo.
  ggml: z.object({
    small: ModelSchema,
    medium: ModelSchema,
    'large-v3-turbo': ModelSchema,
    'large-v3': ModelSchema
  }),
  cuda: z.object({
    'win32-x64': z.array(WheelSchema).min(1),
    'linux-x64': z.array(WheelSchema).min(1)
  })
})

export type Manifest = z.infer<typeof ManifestSchema>
export type ModelManifest = Manifest['models'][ModelId]
export type ManifestFile = z.infer<typeof FileSchema>
export type Wheel = z.infer<typeof WheelSchema>

export function parseManifest(data: unknown): Manifest {
  return ManifestSchema.parse(data)
}

export function modelFileUrl(model: ModelManifest, file: ManifestFile): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`
}

export function modelSize(model: ModelManifest): number {
  return model.files.reduce((total, file) => total + file.size, 0)
}

export function cudaSize(wheels: Wheel[]): number {
  return wheels.reduce((total, wheel) => total + wheel.size, 0)
}

export function cudaTarget(platform: string, arch: string): CudaTarget | null {
  const key = `${platform}-${arch}`
  return CUDA_TARGETS.find((target) => target === key) ?? null
}

const EXACT_HOSTS = new Set([
  'huggingface.co',
  'pypi.org',
  'files.pythonhosted.org',
  'api.github.com'
])
const HOST_SUFFIXES = ['.huggingface.co', '.hf.co'] // CDNs do Hugging Face (LFS e Xet)

export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
