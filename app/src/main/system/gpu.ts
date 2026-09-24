import type { Accelerator, GpuVendor } from '../../shared/events'

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number }
) => Promise<{ stdout: string }>

export interface DetectedGpu {
  name: string
  vendor: GpuVendor
}

const VENDOR_RULES: [RegExp, GpuVendor, string][] = [
  [/nvidia/i, 'nvidia', 'NVIDIA'],
  [/\bamd\b|\bati\b|advanced micro|radeon/i, 'amd', 'AMD'],
  [/intel/i, 'intel', 'Intel']
]

function vendorOf(text: string): { vendor: GpuVendor; label: string | null } {
  const rule = VENDOR_RULES.find(([pattern]) => pattern.test(text))
  return rule ? { vendor: rule[1], label: rule[2] } : { vendor: 'other', label: null }
}

// Adaptadores sem aceleração de verdade: genérico, área de trabalho remota, VMs (VirtualBox,
// VMware, QEMU/virtio/QXL/bochs — fabricante "1234" sem nome —, Hyper-V, Parallels), USB
// (DisplayLink) e placas de gerenciamento de servidor (ASPEED, Matrox G200). Neles o whisper.cpp
// não acha dispositivo Vulkan.
const NOT_A_GPU =
  /microsoft (basic|remote)|hyper-v|virtual|virtio|qxl|bochs|cirrus|innotek|citrix|parsec|vmware|parallels|displaylink|aspeed|matrox|^device 1234\b/i

function isVideo(kind: string, maker: string, device: string): boolean {
  return /VGA|3D|Display/.test(kind) && maker !== '' && !NOT_A_GPU.test(`${maker} ${device}`)
}

/** `lspci -mm`: "slot" "classe" "fabricante" "dispositivo" ... — só controladores de vídeo. */
export function parseLspci(stdout: string): DetectedGpu[] {
  return stdout.split('\n').flatMap((line) => {
    const [kind = '', maker = '', device = ''] = [...line.matchAll(/"([^"]*)"/g)].map((m) =>
      String(m[1])
    )
    if (!isVideo(kind, maker, device)) return []
    const { vendor, label } = vendorOf(maker)
    const model = /\[([^\]]+)\]/.exec(device)?.[1] ?? device
    return [{ name: `${label ?? String(maker.split(' ')[0])} ${model}`.trim(), vendor }]
  })
}

/** Saída de `(Get-CimInstance Win32_VideoController).Name`: um nome por linha. */
export function parseWindowsGpus(stdout: string): DetectedGpu[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name !== '' && !NOT_A_GPU.test(name))
    .map((name) => ({ name, vendor: vendorOf(name).vendor }))
}

// Dedicada antes da integrada: é a que o whisper.cpp deve usar.
const RANK: Record<GpuVendor, number> = { nvidia: 0, amd: 0, apple: 0, other: 1, intel: 2 }

function best(gpus: DetectedGpu[]): Accelerator | null {
  const [first] = [...gpus].sort((a, b) => RANK[a.vendor] - RANK[b.vendor])
  return first ? { name: first.name, api: 'vulkan' } : null
}

async function run(execFile: ExecFileFn, file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile(file, args, { timeout: 5000 })
  return stdout
}

async function appleSilicon(execFile: ExecFileFn): Promise<Accelerator> {
  try {
    const name = (await run(execFile, 'sysctl', ['-n', 'machdep.cpu.brand_string'])).trim()
    return { name: name === '' ? 'Apple Silicon' : name, api: 'metal' }
  } catch {
    return { name: 'Apple Silicon', api: 'metal' }
  }
}

const WINDOWS_QUERY = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '(Get-CimInstance Win32_VideoController).Name'
]

/**
 * GPU que o whisper.cpp pode usar: Vulkan (Windows/Linux x64, qualquer fabricante) ou Metal
 * (macOS Apple Silicon). Se ela não funcionar de fato, o autoteste e a fila caem para a CPU.
 */
export async function detectAccelerator(
  platform: string,
  arch: string,
  execFile: ExecFileFn
): Promise<Accelerator | null> {
  if (platform === 'darwin') return arch === 'arm64' ? appleSilicon(execFile) : null
  if (arch !== 'x64') return null
  try {
    if (platform === 'win32')
      return best(parseWindowsGpus(await run(execFile, 'powershell', WINDOWS_QUERY)))
    if (platform === 'linux') return best(parseLspci(await run(execFile, 'lspci', ['-mm'])))
  } catch {
    // comando ausente (ex.: Linux sem pciutils): sem aceleração detectada
  }
  return null
}
