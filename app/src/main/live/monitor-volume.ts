import type { MonitorVolume } from '../../shared/ipc'

/**
 * Volume do monitor da saída padrão do PipeWire (Linux): é dele que o loopback do Chromium lê os
 * "Outros". Se algum programa o baixa, o fone toca normal e a gravação recebe silêncio.
 */
export type MonitorExec = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string }>

export interface MonitorVolumeState extends MonitorVolume {
  nodeId: number
  channels: number
}

const EXEC_OPTIONS = { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }

interface DumpObject {
  id?: number
  type?: string
  props?: Record<string, unknown>
  metadata?: { key?: string; value?: unknown }[]
  info?: {
    props?: Record<string, unknown>
    params?: { Props?: Record<string, unknown>[] }
  }
}

function defaultSink(objects: DumpObject[]): string | null {
  const metadata = objects.find(
    (o) => o.type === 'PipeWire:Interface:Metadata' && o.props?.['metadata.name'] === 'default'
  )
  const entry = metadata?.metadata?.find((m) => m.key === 'default.audio.sink')
  const value = entry?.value as { name?: unknown } | string | undefined
  // Versões antigas gravam o valor como texto JSON em vez de objeto.
  const parsed = typeof value === 'string' ? (JSON.parse(value) as { name?: unknown }) : value
  return typeof parsed?.name === 'string' ? parsed.name : null
}

/** Os mixers (pavucontrol, wpctl) mostram o volume na escala cúbica: 0,125 linear = 50%. */
const toPercent = (linear: number): number => Math.round(Math.cbrt(linear) * 100)
const toLinear = (percent: number): number => (Math.min(100, Math.max(0, percent)) / 100) ** 3

function sinkNode(objects: DumpObject[], sink: string | null): DumpObject | undefined {
  if (sink === null) return undefined
  return objects.find(
    (o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === sink
  )
}

function monitorProps(node: DumpObject | undefined): Record<string, unknown> | undefined {
  return node?.info?.params?.Props?.find(
    (p) => Array.isArray(p.monitorVolumes) && p.monitorVolumes.length > 0
  )
}

/** Saída de `pw-dump`: o volume do monitor da saída padrão, ou null se não der para saber. */
export function parseMonitorVolume(stdout: string): MonitorVolumeState | null {
  let objects: DumpObject[]
  let sink: string | null
  try {
    objects = JSON.parse(stdout) as DumpObject[]
    sink = defaultSink(objects)
  } catch {
    return null
  }
  const node = sinkNode(objects, sink)
  const props = monitorProps(node)
  if (node?.id === undefined || !props) return null
  const volumes = props.monitorVolumes as number[]
  const description = node.info?.props?.['node.description']
  return {
    nodeId: node.id,
    channels: volumes.length,
    sink: typeof description === 'string' ? description : String(sink),
    percent: toPercent(Math.max(...volumes)),
    muted: props.monitorMute === true
  }
}

export function createMonitorVolume(deps: { platform: NodeJS.Platform; exec: MonitorExec }) {
  async function state(): Promise<MonitorVolumeState | null> {
    if (deps.platform !== 'linux') return null
    try {
      return parseMonitorVolume((await deps.exec('pw-dump', [], EXEC_OPTIONS)).stdout)
    } catch {
      return null
    }
  }
  const publicView = (s: MonitorVolumeState | null): MonitorVolume | null =>
    s && { sink: s.sink, percent: s.percent, muted: s.muted }

  return {
    async read(): Promise<MonitorVolume | null> {
      return publicView(await state())
    },
    /** Ajusta todos os canais (e tira o mudo); devolve o volume relido. */
    async set(percent: number): Promise<MonitorVolume | null> {
      const current = await state()
      if (!current) return null
      const linear = Number(toLinear(percent).toFixed(6))
      const volumes = Array.from({ length: current.channels }, () => linear).join(', ')
      await deps.exec(
        'pw-cli',
        [
          'set-param',
          String(current.nodeId),
          'Props',
          `{ monitorMute: false, monitorVolumes: [ ${volumes} ] }`
        ],
        EXEC_OPTIONS
      )
      return publicView(await state())
    }
  }
}
