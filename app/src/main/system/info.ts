import type { GpuInfo, SystemInfo } from '../../shared/events'
import { recommendModel } from '../../shared/models'
import { cudaTarget } from '../downloads/manifest'
import { detectAccelerator, type ExecFileFn } from './gpu'

export type { ExecFileFn } from './gpu'

export function parseNvidiaSmi(stdout: string): GpuInfo | null {
  const parts = String(stdout.split(/\r?\n/)[0]).split(',')
  if (parts.length < 2) return null
  const name = String(parts[0]).trim()
  const memoryMb = Number(parts[1])
  return name !== '' && Number.isFinite(memoryMb) ? { name, memoryMb } : null
}

export async function detectNvidiaGpu(
  platform: string,
  execFile: ExecFileFn
): Promise<GpuInfo | null> {
  if (platform === 'darwin') return null
  try {
    const { stdout } = await execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 }
    )
    return parseNvidiaSmi(stdout)
  } catch {
    return null
  }
}

export async function getSystemInfo(deps: {
  platform: string
  arch: string
  totalmem: () => number
  execFile: ExecFileFn
}): Promise<SystemInfo> {
  const [gpu, accelerator] = await Promise.all([
    detectNvidiaGpu(deps.platform, deps.execFile),
    detectAccelerator(deps.platform, deps.arch, deps.execFile)
  ])
  const ramBytes = deps.totalmem()
  const cudaSupported = gpu !== null && cudaTarget(deps.platform, deps.arch) !== null
  // NVIDIA vence (CUDA é o caminho mais rápido); qualquer outra GPU vai pelo whisper.cpp.
  const recommendedDevice = cudaSupported ? 'cuda' : accelerator ? 'gpu' : 'cpu'
  return {
    platform: deps.platform,
    arch: deps.arch,
    ramBytes,
    gpu,
    cudaSupported,
    accelerator,
    recommendedDevice,
    recommendedModel: recommendModel({ ramBytes, hasNvidiaGpu: gpu !== null })
  }
}
