import { describe, expect, it, vi } from 'vitest'
import {
  createMonitorVolume,
  parseMonitorVolume,
  type MonitorExec
} from '../../../src/main/live/monitor-volume'

const SINK = 'alsa_output.usb-Headset.analog-stereo'

function dump(props: Record<string, unknown>, sink = SINK): string {
  return JSON.stringify([
    {
      id: 44,
      type: 'PipeWire:Interface:Metadata',
      props: { 'metadata.name': 'default' },
      metadata: [
        { subject: 0, key: 'default.audio.source', value: { name: 'alsa_input.mic' } },
        { subject: 0, key: 'default.audio.sink', value: { name: sink } }
      ]
    },
    {
      id: 86,
      type: 'PipeWire:Interface:Node',
      info: {
        props: { 'node.name': 'alsa_output.other', 'node.description': 'Outra saída' },
        params: { Props: [{ monitorMute: false, monitorVolumes: [1, 1] }] }
      }
    },
    {
      id: 84,
      type: 'PipeWire:Interface:Node',
      info: {
        props: { 'node.name': SINK, 'node.description': 'Headset USB' },
        params: { Props: [props, { device: 'front:1' }] }
      }
    }
  ])
}

describe('parseMonitorVolume', () => {
  it('lê o volume do monitor da saída padrão na escala do mixer (cúbica)', () => {
    const parsed = parseMonitorVolume(dump({ monitorMute: false, monitorVolumes: [0.125, 0.125] }))
    expect(parsed).toEqual({
      nodeId: 84,
      channels: 2,
      sink: 'Headset USB',
      percent: 50,
      muted: false
    })
  })

  it('o quase mudo que silenciava os "Outros" vira 8%', () => {
    const parsed = parseMonitorVolume(
      dump({ monitorMute: true, monitorVolumes: [0.000482, 0.000482] })
    )
    expect(parsed).toMatchObject({ percent: 8, muted: true })
  })

  it('metadata antigo (valor em texto JSON) e saída sem descrição: usa o nome do nó', () => {
    const objects = JSON.parse(dump({ monitorVolumes: [1] })) as {
      metadata?: { value: unknown }[]
      info?: { props: Record<string, unknown> }
    }[]
    const [metadata, , node] = objects
    if (metadata?.metadata?.[1]) metadata.metadata[1].value = JSON.stringify({ name: SINK })
    if (node?.info) delete node.info.props['node.description']
    expect(parseMonitorVolume(JSON.stringify(objects))).toMatchObject({ sink: SINK, percent: 100 })
  })

  it('sem saída padrão, nó ou volume do monitor: null', () => {
    expect(
      parseMonitorVolume(dump({ monitorMute: false, monitorVolumes: [1, 1] }, 'sumiu'))
    ).toBeNull()
    expect(parseMonitorVolume(dump({ volume: 1 }))).toBeNull()
    expect(parseMonitorVolume('[]')).toBeNull()
    expect(parseMonitorVolume('não é json')).toBeNull()
  })
})

describe('createMonitorVolume', () => {
  it('fora do Linux não há o que ler nem ajustar', async () => {
    const exec = vi.fn<MonitorExec>()
    const monitor = createMonitorVolume({ platform: 'win32', exec })
    expect(await monitor.read()).toBeNull()
    expect(await monitor.set(100)).toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })

  it('sem o PipeWire (pw-dump falha): null', async () => {
    const exec = vi.fn<MonitorExec>(() => Promise.reject(new Error('ENOENT')))
    expect(await createMonitorVolume({ platform: 'linux', exec }).read()).toBeNull()
  })

  it('ajusta todos os canais, tira o mudo e devolve o volume relido', async () => {
    let current = dump({ monitorMute: true, monitorVolumes: [0.000482, 0.000482] })
    const exec = vi.fn<MonitorExec>((file) => {
      if (file === 'pw-cli') current = dump({ monitorMute: false, monitorVolumes: [1, 1] })
      return Promise.resolve({ stdout: file === 'pw-dump' ? current : '' })
    })
    const monitor = createMonitorVolume({ platform: 'linux', exec })
    expect(await monitor.set(100)).toMatchObject({ percent: 100, muted: false })
    const call = exec.mock.calls.find(([file]) => file === 'pw-cli')
    expect(call?.slice(0, 2)).toEqual([
      'pw-cli',
      ['set-param', '84', 'Props', '{ monitorMute: false, monitorVolumes: [ 1, 1 ] }']
    ])
    expect(call?.[2].timeout).toBeGreaterThan(0)
  })

  it('converte a porcentagem do mixer para o volume linear e limita a 0–100', async () => {
    const exec = vi.fn<MonitorExec>((file) =>
      Promise.resolve({ stdout: file === 'pw-dump' ? dump({ monitorVolumes: [1] }) : '' })
    )
    const monitor = createMonitorVolume({ platform: 'linux', exec })
    await monitor.set(50)
    await monitor.set(250)
    const calls = exec.mock.calls.filter(([file]) => file === 'pw-cli').map(([, args]) => args[3])
    expect(calls).toEqual([
      '{ monitorMute: false, monitorVolumes: [ 0.125 ] }',
      '{ monitorMute: false, monitorVolumes: [ 1 ] }'
    ])
  })
})
