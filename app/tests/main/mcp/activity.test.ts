import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLog } from '../../../src/main/mcp/activity'
import { makeTempDir } from '../../helpers/tmp'

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0)

function clock(): () => Date {
  let calls = 0
  return () => new Date(BASE + calls++ * 1000)
}

describe('ActivityLog', () => {
  let root: string
  let path: string

  beforeEach(async () => {
    root = await makeTempDir()
    path = join(root, 'mcp', 'activity.jsonl')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('record cria a pasta e acrescenta uma linha com o horário', async () => {
    const log = new ActivityLog(path, clock())
    await log.record({ client: 'codex', tool: 'list_transcriptions', title: 'Reunião' })
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw.trim())).toEqual({
      at: new Date(BASE).toISOString(),
      client: 'codex',
      tool: 'list_transcriptions',
      title: 'Reunião'
    })
  })

  it('usa o relógio do sistema quando não recebe um', async () => {
    const log = new ActivityLog(path)
    await log.record({ client: 'codex', tool: 'list_transcriptions' })
    const raw = await readFile(path, 'utf8')
    const entry = JSON.parse(raw.trim()) as { at: string }
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it.skipIf(process.platform === 'win32')('cria a pasta mcp com modo 0700', async () => {
    const log = new ActivityLog(path, clock())
    await log.record({ client: 'a', tool: 'x' })
    expect((await stat(join(root, 'mcp'))).mode & 0o777).toBe(0o700)
  })

  it('recent devolve as mais recentes primeiro (50 por padrão)', async () => {
    const log = new ActivityLog(path, clock())
    for (let i = 1; i <= 60; i++) await log.record({ client: 'a', tool: 't', title: `l${i}` })
    const recent = await log.recent()
    expect(recent).toHaveLength(50)
    expect(recent[0]?.title).toBe('l60')
    expect(recent[49]?.title).toBe('l11')
    expect((await log.recent(2)).map((line) => line.title)).toEqual(['l60', 'l59'])
    expect(await log.recent(0)).toEqual([])
  })

  it('rotaciona ao passar de 500 linhas mantendo as 500 últimas', async () => {
    const log = new ActivityLog(path, clock())
    for (let i = 0; i <= 500; i++) await log.record({ client: 'a', tool: 't', title: `l${i}` })
    const recent = await log.recent(1000)
    expect(recent).toHaveLength(500)
    expect(recent[0]?.title).toBe('l500')
    expect(recent[recent.length - 1]?.title).toBe('l1')
    const raw = await readFile(path, 'utf8')
    expect(raw.trimEnd().split('\n')).toHaveLength(500)
  })

  it('ignora linhas corrompidas, inclusive truncada no fim', async () => {
    await mkdir(join(root, 'mcp'), { recursive: true })
    await writeFile(
      path,
      [
        '{"at":"2026-01-01T12:00:00.000Z","client":"a","tool":"x"}',
        '{"at":"2026-01-01T12:00:01.000Z"}',
        'nao e json',
        '{"at":"2026-01-01T12:00'
      ].join('\n'),
      'utf8'
    )
    const log = new ActivityLog(path, clock())
    expect(await log.recent()).toEqual([{ at: '2026-01-01T12:00:00.000Z', client: 'a', tool: 'x' }])
  })

  it('arquivo inexistente → sem linhas', async () => {
    const log = new ActivityLog(path, clock())
    expect(await log.recent()).toEqual([])
    expect(await log.lastUseByClient()).toEqual(new Map())
  })

  it('lastUseByClient devolve o mais recente de cada cliente', async () => {
    await mkdir(join(root, 'mcp'), { recursive: true })
    await writeFile(
      path,
      [
        '{"at":"2026-01-01T10:00:00.000Z","client":"claude-code","tool":"list"}',
        '{"at":"2026-01-01T11:00:00.000Z","client":"codex","tool":"get"}',
        '{"at":"2026-01-01T12:00:00.000Z","client":"claude-code","tool":"read"}',
        '{"at":"2026-01-01T09:00:00.000Z","client":"claude-code","tool":"antiga"}',
        '{"truncada',
        ''
      ].join('\n'),
      'utf8'
    )
    const log = new ActivityLog(path, clock())
    expect(await log.lastUseByClient()).toEqual(
      new Map([
        ['claude-code', '2026-01-01T12:00:00.000Z'],
        ['codex', '2026-01-01T11:00:00.000Z']
      ])
    )
  })
})
