import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { launch, makeUserData, mediaFile, mockDialogs } from './fixtures'

const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

/** Roda o axe dentro da página (page.evaluate não passa pela CSP) só com a regra de contraste. */
async function contrastViolations(page: Page): Promise<string[]> {
  await page.evaluate(AXE)
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            o: object
          ) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>
        }
      }
    ).axe
    const result = await axe.run({ runOnly: ['color-contrast'] })
    return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  })
}

async function withHistory(page: Page, app: Parameters<typeof mockDialogs>[0]): Promise<void> {
  await mockDialogs(app, { open: [mediaFile('contraste.mp3')] })
  await page.getByRole('button', { name: 'Adicionar' }).click()
  await expect(page.getByRole('tab', { name: 'Texto' })).toBeVisible()
}

for (const theme of ['light', 'dark'] as const) {
  test(`tema ${theme}: cores aplicadas e contraste AA na tela principal e nas configurações`, async () => {
    const { app, page } = await launch(makeUserData({ theme }))
    await withHistory(page, app)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe(theme === 'dark' ? 'rgb(10, 10, 11)' : 'rgb(238, 242, 247)')
    expect(await contrastViolations(page)).toEqual([])
    await page.getByRole('button', { name: 'Configurações' }).click()
    expect(await contrastViolations(page)).toEqual([])
    await app.close()
  })
}

test('trocar o tema e o idioma nas configurações vale na hora', async () => {
  const { app, page } = await launch(makeUserData({}))
  await page.getByRole('button', { name: 'Configurações' }).click()
  // Rádio controlado pelas configurações salvas: marca quando o main confirma (ida e volta pela IPC).
  const dark = page.getByRole('radio', { name: 'Escuro' })
  await dark.click()
  await expect(dark).toBeChecked()
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe('rgb(10, 10, 11)')
  await page.getByLabel('Idioma da interface').selectOption('en')
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await app.close()
})

test('janela mínima (960×600) sem rolagem horizontal, em espanhol', async () => {
  const { app, page } = await launch(makeUserData({ uiLanguage: 'es' }))
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(960, 600)
  })
  await withHistoryEs(page, app)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await app.close()
})

async function withHistoryEs(page: Page, app: Parameters<typeof mockDialogs>[0]): Promise<void> {
  await mockDialogs(app, { open: [mediaFile('una clase con un nombre bastante largo.mp3')] })
  await page.getByRole('button', { name: 'Agregar' }).click()
  await expect(page.getByRole('tab', { name: 'Texto' })).toBeVisible()
}
