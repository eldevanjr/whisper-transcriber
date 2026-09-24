import { expect, test } from '@playwright/test'
import { fakeModel, launch, makeUserData, mockNetwork } from './fixtures'

test('onboarding completo: idioma, modelo, download verificado, teste do motor e tela principal', async () => {
  const model = fakeModel()
  const { app, page } = await launch(makeUserData(), { WT_DOWNLOADS_MANIFEST: model.manifestPath })
  await mockNetwork(app, model.files)

  await expect(
    page.getByRole('heading', { name: 'Bem-vindo ao Whisper Transcriber' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Continuar' }).click()
  await page.getByRole('radio', { name: /Small/ }).check()
  await page.getByRole('button', { name: 'Baixar e continuar' }).click()

  await expect(page.getByText('✓ verificado')).toHaveCount(2) // modelo e teste do motor
  await page.getByRole('button', { name: 'Começar' }).click()
  await expect(page.getByText('Solte vídeos ou áudios aqui')).toBeVisible()
  await app.close()
})

test('renderer isolado: sem Node, só a API do preload, sem novas janelas e sem navegar para fora', async () => {
  const { app, page } = await launch(makeUserData({}))
  const probe = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    api: Object.keys((window as unknown as { transcriber: object }).transcriber).sort()
  }))
  expect(probe.require).toBe('undefined')
  expect(probe.process).toBe('undefined')
  expect(probe.api).toContain('queue')

  const opened = await page.evaluate(() => window.open('https://evil.example') === null)
  expect(opened).toBe(true)
  expect(app.windows()).toHaveLength(1)

  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://evil.example'
  })
  await page.waitForTimeout(300)
  expect(page.url()).toBe(before)
  await app.close()
})

test('erros do main atravessam a ponte com código (senão toda mensagem vira "Algo deu errado")', async () => {
  const { app, page } = await launch(makeUserData({}))
  const failure = await page.evaluate(() =>
    (
      window as unknown as {
        transcriber: { system: { openExternal: (u: string) => Promise<unknown> } }
      }
    ).transcriber.system
      .openExternal('https://evil.example')
      .then(
        () => null,
        (error: unknown) => ({
          ...(error as object),
          message: (error as { message?: string }).message
        })
      )
  )
  expect(failure).toMatchObject({ code: 'INVALID_REQUEST', message: 'Link não permitido' })
  await app.close()
})
