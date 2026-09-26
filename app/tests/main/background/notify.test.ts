import { describe, expect, it, vi } from 'vitest'
import { Notifier, type NotificationCtor } from '../../../src/main/background/notify'

function setup(supported = true, icon?: string) {
  const created: { options: unknown; handlers: Map<string, () => void>; show: () => void }[] = []
  const Notification = vi.fn(function (this: unknown, options: unknown) {
    const handlers = new Map<string, () => void>()
    const instance = {
      options,
      handlers,
      show: vi.fn(),
      on: (event: string, handler: () => void) => handlers.set(event, handler)
    }
    created.push(instance)
    return instance
  }) as unknown as NotificationCtor & { isSupported: () => boolean }
  Notification.isSupported = () => supported
  const open = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const notifier = new Notifier({ Notification, open, logger, ...(icon ? { icon } : {}) })
  return { notifier, created, open, logger }
}

describe('Notifier', () => {
  it('mostra, registra no log e abre o destino no clique', () => {
    const { notifier, created, open, logger } = setup()
    notifier.show('Reunião salva', 'Reunião — 12 min', { kind: 'item', id: 'x' })
    expect(created[0]!.options).toEqual({ title: 'Reunião salva', body: 'Reunião — 12 min' })
    expect(created[0]!.show).toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('[notificação] Reunião salva — Reunião — 12 min')
    created[0]!.handlers.get('click')!()
    expect(open).toHaveBeenCalledWith({ kind: 'item', id: 'x' })
    created[0]!.handlers.get('close')!() // fechar depois do clique não quebra
  })

  it('ícone quando informado (Linux)', () => {
    const { notifier, created } = setup(true, '/r/icon.png')
    notifier.show('a', 'b', { kind: 'window' })
    expect(created[0]!.options).toMatchObject({ icon: '/r/icon.png' })
  })

  it('sistema sem notificações: só o log', () => {
    const { notifier, created, logger } = setup(false)
    notifier.show('a', 'b', { kind: 'live' })
    expect(created).toHaveLength(0)
    expect(logger.info).toHaveBeenCalled()
  })
})
