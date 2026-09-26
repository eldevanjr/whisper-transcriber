import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, makeUserData } from './fixtures'

interface Hooks {
  __wtBackground: { toggle(): void; snapshot(): { live: string } }
}

// Mesmo manipulador do clique na bandeja e do atalho global (que o CI não consegue apertar).
test('bandeja: janela fechada continua o app, grava e salva sem abrir a janela', async () => {
  const userData = makeUserData({ live: { micDeviceId: null, systemAudio: false, pauseS: 1 } })
  const { app, page } = await launch(userData, { WT_E2E_HOOKS: '1' })
  await expect(page.getByRole('button', { name: 'Ao vivo' })).toBeVisible()

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close()
  })
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())
  ).toBe(false)

  const liveState = () =>
    app.evaluate(() => (globalThis as unknown as Hooks).__wtBackground.snapshot().live)
  await app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__wtBackground.toggle()
  })
  await expect.poll(liveState, { timeout: 10_000 }).toBe('recording')
  await page.waitForTimeout(2500) // o worker falso manda um trecho a cada 2 s de áudio
  await app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__wtBackground.toggle()
  })
  await expect.poll(liveState, { timeout: 10_000 }).toBe('idle')

  const log = () => readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
  await expect.poll(log).toContain('[notificação] Continua na bandeja')
  await expect.poll(log).toContain('[notificação] Gravando — Só Você')
  await expect.poll(log).toContain('[notificação] Reunião salva')

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
  await expect(page.getByRole('heading', { name: /^Reunião / })).toBeVisible()
  await app.close()
})
