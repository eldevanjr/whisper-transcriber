import { expect, test } from '@playwright/test'
import { launch, makeUserData, mediaFile, mockDialogs } from './fixtures'

test('fechar no meio da transcrição: ao reabrir fica "Interrompido" e dá para transcrever de novo', async () => {
  const userData = makeUserData({})
  const first = await launch(userData)
  await mockDialogs(first.app, { open: [mediaFile('lento.mp3')] })
  await first.page.getByRole('button', { name: 'Adicionar' }).click()
  await expect(first.page.getByRole('button', { name: /Bom dia a todos\./ })).toBeVisible()
  await first.app.close()

  const second = await launch(userData)
  const history = second.page.getByRole('region', { name: 'Histórico' })
  await expect(history).toContainText('Interrompido')
  await history.getByRole('button', { name: /^lento\.mp3/ }).click()
  await expect(second.page.getByRole('button', { name: /Bom dia a todos\./ })).toBeVisible() // parcial salvo
  await history.getByRole('button', { name: 'Transcrever de novo: lento.mp3' }).click()
  await expect(history).toContainText('Concluído', { timeout: 20_000 })
  await second.app.close()
})

test('histórico persiste entre aberturas e pode ser limpo com alerta', async () => {
  const userData = makeUserData({})
  const first = await launch(userData)
  await mockDialogs(first.app, { open: [mediaFile('guardado.mp3')] })
  await first.page.getByRole('button', { name: 'Adicionar' }).click()
  await expect(first.page.getByRole('tab', { name: 'Texto' })).toBeVisible()
  await first.app.close()

  const { app, page } = await launch(userData)
  await expect(page.getByRole('region', { name: 'Histórico' })).toContainText('guardado.mp3')
  await page.getByRole('button', { name: 'Configurações' }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Armazenamento' }).click()
  await page.getByRole('button', { name: 'Limpar histórico…' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Apagar 1 transcrições')
  await page.getByRole('button', { name: 'Apagar tudo' }).click()
  await expect(page.getByText('Histórico apagado.')).toBeVisible()
  await page.getByRole('button', { name: 'Voltar' }).click()
  await expect(page.getByText('Nada por aqui ainda.')).toBeVisible()
  await app.close()
})
