import { describe, expect, it, vi } from 'vitest'
import { detectNvidiaGpu, getSystemInfo, parseNvidiaSmi } from '../../../src/main/system/info'

const GB = 1024 ** 3

describe('parseNvidiaSmi', () => {
  it.each([
    ['NVIDIA GeForce RTX 3060, 12288\n', { name: 'NVIDIA GeForce RTX 3060', memoryMb: 12288 }],
    ['RTX A4000, 16376\r\nRTX A4000, 16376\r\n', { name: 'RTX A4000', memoryMb: 16376 }],
    ['', null],
    ['sem virgula', null],
    ['RTX, abc', null],
    [', 100', null]
  ])('%j → %j', (stdout, expected) => {
    expect(parseNvidiaSmi(stdout)).toEqual(expected)
  })
})

describe('detectNvidiaGpu', () => {
  it('consulta o nvidia-smi com timeout', async () => {
    const execFile = vi.fn(() => Promise.resolve({ stdout: 'RTX 3060, 12288\n' }))
    expect(await detectNvidiaGpu('win32', execFile)).toEqual({ name: 'RTX 3060', memoryMb: 12288 })
    expect(execFile).toHaveBeenCalledWith(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000 }
    )
  })

  it('sem nvidia-smi (erro) → null', async () => {
    expect(await detectNvidiaGpu('linux', () => Promise.reject(new Error('ENOENT')))).toBeNull()
  })

  it('macOS nunca consulta', async () => {
    const execFile = vi.fn()
    expect(await detectNvidiaGpu('darwin', execFile)).toBeNull()
    expect(execFile).not.toHaveBeenCalled()
  })
})

const route = (outputs: Record<string, string>) => (file: string) =>
  outputs[file] === undefined
    ? Promise.reject(new Error('ENOENT'))
    : Promise.resolve({ stdout: outputs[file] })

describe('getSystemInfo', () => {
  it('com GPU NVIDIA suportada recomenda Large v3 Turbo e CUDA', async () => {
    const info = await getSystemInfo({
      platform: 'linux',
      arch: 'x64',
      totalmem: () => 16 * GB,
      execFile: route({
        'nvidia-smi': 'RTX 3060, 12288',
        lspci: '01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA106 [GeForce RTX 3060]"'
      })
    })
    expect(info).toEqual({
      platform: 'linux',
      arch: 'x64',
      ramBytes: 16 * GB,
      gpu: { name: 'RTX 3060', memoryMb: 12288 },
      cudaSupported: true,
      accelerator: { name: 'NVIDIA GeForce RTX 3060', api: 'vulkan' },
      recommendedDevice: 'cuda',
      recommendedModel: 'large-v3-turbo'
    })
  })

  it('GPU Intel/AMD sem NVIDIA recomenda a GPU pelo whisper.cpp', async () => {
    const info = await getSystemInfo({
      platform: 'linux',
      arch: 'x64',
      totalmem: () => 16 * GB,
      execFile: route({
        lspci:
          '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-UP3 GT2 [Iris Xe Graphics]"'
      })
    })
    expect(info).toMatchObject({
      gpu: null,
      cudaSupported: false,
      accelerator: { name: 'Intel Iris Xe Graphics', api: 'vulkan' },
      recommendedDevice: 'gpu',
      recommendedModel: 'medium'
    })
  })

  it('sem GPU e pouca RAM recomenda Small e não oferece CUDA', async () => {
    const info = await getSystemInfo({
      platform: 'darwin',
      arch: 'arm64',
      totalmem: () => 4 * GB,
      execFile: vi.fn()
    })
    expect(info.cudaSupported).toBe(false)
    expect(info.recommendedModel).toBe('small')
    expect(info.recommendedDevice).toBe('gpu') // Apple Silicon: Metal
  })

  it('GPU em arquitetura sem CUDA (Linux ARM) não oferece CUDA', async () => {
    const info = await getSystemInfo({
      platform: 'linux',
      arch: 'arm64',
      totalmem: () => 16 * GB,
      execFile: route({ 'nvidia-smi': 'Orin, 8000' })
    })
    expect(info.cudaSupported).toBe(false)
    expect(info.recommendedDevice).toBe('cpu')
  })
})
