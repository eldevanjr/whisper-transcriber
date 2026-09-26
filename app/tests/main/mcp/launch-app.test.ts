import { describe, expect, it, vi } from 'vitest'
import {
  APP_POLL_MS,
  APP_START_TIMEOUT_MS,
  createAppRunner,
  defaultSpawn,
  ensureAppRunning
} from '../../../src/main/mcp/launch-app'
import { AppError } from '../../../src/shared/errors'

interface ConnectResult {
  ready: boolean
}

function clientThat(connect: () => Promise<ConnectResult>) {
  return { connect: vi.fn(connect) }
}

function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    }
  }
}

describe('ensureAppRunning', () => {
  it('exposes the spec timing constants', () => {
    expect(APP_START_TIMEOUT_MS).toBe(60_000)
    expect(APP_POLL_MS).toBe(500)
  })

  it('does not launch when the app already answers', async () => {
    const client = clientThat(async () => ({ ready: true }))
    const spawn = vi.fn()
    await ensureAppRunning({ launcherTarget: { command: '/app', args: [] }, client, spawn })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('launches once and waits for the bridge', async () => {
    let reachable = false
    const client = clientThat(async () => {
      if (!reachable) throw new AppError('WORKER_UNAVAILABLE', 'closed')
      return { ready: true }
    })
    const spawn = vi.fn(() => {
      reachable = true
    })
    const clock = fakeClock()
    await ensureAppRunning({
      launcherTarget: { command: '/app', args: ['--x'] },
      client,
      spawn,
      ...clock
    })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith('/app', ['--x'])
  })

  it('shares a single attempt between concurrent calls', async () => {
    let reachable = false
    const client = clientThat(async () => {
      if (!reachable) throw new AppError('WORKER_UNAVAILABLE', 'closed')
      return { ready: true }
    })
    const spawn = vi.fn(() => {
      reachable = true
    })
    const runner = createAppRunner({
      launcherTarget: { command: '/app', args: [] },
      client,
      spawn,
      ...fakeClock()
    })
    await Promise.all([runner(), runner()])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('throws SETUP_INCOMPLETE when onboarding is pending', async () => {
    const client = clientThat(async () => ({ ready: false }))
    const spawn = vi.fn()
    await expect(
      ensureAppRunning({ launcherTarget: { command: '/app', args: [] }, client, spawn })
    ).rejects.toMatchObject({ code: 'SETUP_INCOMPLETE' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('throws SETUP_INCOMPLETE found after launching', async () => {
    let reachable = false
    const client = clientThat(async () => {
      if (!reachable) throw new AppError('WORKER_UNAVAILABLE', 'closed')
      return { ready: false }
    })
    const spawn = vi.fn(() => {
      reachable = true
    })
    await expect(
      ensureAppRunning({
        launcherTarget: { command: '/app', args: [] },
        client,
        spawn,
        ...fakeClock()
      })
    ).rejects.toMatchObject({ code: 'SETUP_INCOMPLETE' })
  })

  it('throws APP_START_TIMEOUT after 60 s without a bridge', async () => {
    const client = clientThat(async () => {
      throw new AppError('WORKER_UNAVAILABLE', 'closed')
    })
    const spawn = vi.fn()
    await expect(
      ensureAppRunning({
        launcherTarget: { command: '/app', args: [] },
        client,
        spawn,
        ...fakeClock()
      })
    ).rejects.toMatchObject({ code: 'APP_START_TIMEOUT' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('requires a launcher target to open the app', async () => {
    const client = clientThat(async () => {
      throw new AppError('WORKER_UNAVAILABLE', 'closed')
    })
    await expect(
      ensureAppRunning({ launcherTarget: null, client, spawn: vi.fn() })
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  })

  it('spawns a detached process by default', () => {
    const child = defaultSpawn(process.execPath, ['-e', ''])
    expect(typeof child.unref).toBe('function')
  })

  it('spawns with the default spawner when none is injected', async () => {
    let calls = 0
    const client = clientThat(async () => {
      calls += 1
      if (calls === 1) throw new AppError('WORKER_UNAVAILABLE', 'closed')
      return { ready: true }
    })
    const clock = fakeClock()
    // O executável é o próprio Node, que encerra logo; serve só para cobrir o spawn padrão.
    await ensureAppRunning({
      launcherTarget: { command: process.execPath, args: ['-e', ''] },
      client,
      ...clock
    })
    expect(clock.now()).toBeGreaterThan(0)
  })

  it('times out with real timers when none are injected', async () => {
    const client = clientThat(async () => {
      throw new AppError('WORKER_UNAVAILABLE', 'closed')
    })
    await expect(
      ensureAppRunning({
        launcherTarget: { command: '/app', args: [] },
        client,
        spawn: vi.fn(),
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ code: 'APP_START_TIMEOUT' })
  })
})
