import { describe, expect, it, vi } from 'vitest'
import {
  detectAccelerator,
  parseLspci,
  parseWindowsGpus,
  type ExecFileFn
} from '../../../src/main/system/gpu'

const LSPCI = [
  '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-UP3 GT2 [Iris Xe Graphics]" -r0c -p00 "Dell" "Device 0b0b"',
  '00:04.0 "Signal processing controller" "Intel Corporation" "Alder Lake Innovation Platform Framework Processor Participant" -r04 "Dell" "Device 0b0b"',
  '01:00.0 "3D controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 23 [Radeon RX 6600M]" -rc7 "" ""'
].join('\n')

function exec(outputs: Record<string, string | Error>): ExecFileFn {
  return vi.fn((file: string) => {
    const out = outputs[file]
    if (out === undefined || out instanceof Error) return Promise.reject(out ?? new Error('ENOENT'))
    return Promise.resolve({ stdout: out })
  })
}

describe('parseLspci', () => {
  it('lista só controladores de vídeo, com nome legível e fabricante', () => {
    expect(parseLspci(LSPCI)).toEqual([
      { name: 'Intel Iris Xe Graphics', vendor: 'intel' },
      { name: 'AMD Radeon RX 6600M', vendor: 'amd' }
    ])
    expect(
      parseLspci('03:00.0 "Display controller" "NVIDIA Corporation" "AD107M" -ra1 "" ""')
    ).toEqual([{ name: 'NVIDIA AD107M', vendor: 'nvidia' }])
    expect(parseLspci('')).toEqual([])
    expect(parseLspci('00:02.0 "VGA compatible controller"')).toEqual([]) // linha cortada
    expect(parseLspci('07:00.0 "VGA compatible controller" "Moore Threads" "MTT S80"')).toEqual([
      { name: 'Moore MTT S80', vendor: 'other' }
    ])
  })

  it('ignora adaptadores sem aceleração: VMs e placas de gerenciamento de servidor', () => {
    // Sem dispositivo Vulkan o whisper.cpp roda na CPU: não pode aparecer como "GPU".
    const virtual = [
      '00:02.0 "VGA compatible controller" "InnoTek Systemberatung GmbH" "VirtualBox Graphics Adapter" "" ""',
      '00:0f.0 "VGA compatible controller" "VMware" "SVGA II Adapter" "" ""',
      '00:01.0 "VGA compatible controller" "Red Hat, Inc." "Virtio 1.0 GPU" "" ""',
      '00:02.0 "VGA compatible controller" "Red Hat, Inc." "QXL paravirtual graphic card" "" ""',
      '00:02.0 "VGA compatible controller" "Device 1234" "Device 1111" "" ""',
      '00:02.0 "VGA compatible controller" "Cirrus Logic" "GD 5446" "" ""',
      '03:00.0 "VGA compatible controller" "ASPEED Technology, Inc." "ASPEED Graphics Family" "" ""',
      '00:01.0 "VGA compatible controller" "Matrox Electronics Systems Ltd." "G200eR2" "" ""',
      '00:08.0 "VGA compatible controller" "Microsoft Corporation" "Hyper-V virtual VGA" "" ""'
    ].join('\n')
    expect(parseLspci(virtual)).toEqual([])
  })
})

describe('parseWindowsGpus', () => {
  it('ignora adaptadores genéricos/remotos e identifica o fabricante pelo nome', () => {
    expect(
      parseWindowsGpus(
        'Intel(R) UHD Graphics 620\r\nMicrosoft Basic Display Adapter\r\nAMD Radeon(TM) Graphics\r\nMicrosoft Remote Display Adapter\r\nNVIDIA GeForce RTX 4060\r\n\r\n'
      )
    ).toEqual([
      { name: 'Intel(R) UHD Graphics 620', vendor: 'intel' },
      { name: 'AMD Radeon(TM) Graphics', vendor: 'amd' },
      { name: 'NVIDIA GeForce RTX 4060', vendor: 'nvidia' }
    ])
    expect(
      parseWindowsGpus(
        'Microsoft Hyper-V Video\r\nParallels Display Adapter (WDDM)\r\nDisplayLink USB Device\r\nVirtualBox Graphics Adapter (WDDM)\r\nVMware SVGA 3D\r\n'
      )
    ).toEqual([])
  })
})

describe('detectAccelerator', () => {
  it('Linux: prefere a GPU dedicada (AMD) à integrada, via Vulkan', async () => {
    expect(await detectAccelerator('linux', 'x64', exec({ lspci: LSPCI }))).toEqual({
      name: 'AMD Radeon RX 6600M',
      api: 'vulkan'
    })
  })

  it('Linux só com a integrada Intel usa a Intel', async () => {
    const only = LSPCI.split('\n')[0]!
    expect(await detectAccelerator('linux', 'x64', exec({ lspci: only }))).toEqual({
      name: 'Intel Iris Xe Graphics',
      api: 'vulkan'
    })
  })

  it('Windows via PowerShell; sem GPU real → null', async () => {
    const run = exec({ powershell: 'AMD Radeon RX 7600\r\n' })
    expect(await detectAccelerator('win32', 'x64', run)).toEqual({
      name: 'AMD Radeon RX 7600',
      api: 'vulkan'
    })
    expect(run).toHaveBeenCalledWith(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      { timeout: 5000 }
    )
    expect(
      await detectAccelerator(
        'win32',
        'x64',
        exec({ powershell: 'Microsoft Basic Display Adapter' })
      )
    ).toBeNull()
  })

  it('macOS Apple Silicon: Metal com o nome do chip; Intel Mac não tem aceleração', async () => {
    expect(await detectAccelerator('darwin', 'arm64', exec({ sysctl: 'Apple M2 Pro\n' }))).toEqual({
      name: 'Apple M2 Pro',
      api: 'metal'
    })
    expect(await detectAccelerator('darwin', 'arm64', exec({ sysctl: '\n' }))).toEqual({
      name: 'Apple Silicon',
      api: 'metal'
    })
    expect(await detectAccelerator('darwin', 'arm64', exec({}))).toEqual({
      name: 'Apple Silicon',
      api: 'metal'
    })
    expect(await detectAccelerator('darwin', 'x64', exec({}))).toBeNull()
  })

  it('comando ausente ou sistema desconhecido → null', async () => {
    expect(await detectAccelerator('linux', 'x64', exec({}))).toBeNull()
    expect(await detectAccelerator('freebsd', 'x64', exec({}))).toBeNull()
  })
})
