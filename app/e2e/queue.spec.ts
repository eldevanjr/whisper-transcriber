import { expect, test } from '@playwright/test'
import { launch, makeUserData, mediaFile, mockDialogs } from './fixtures'

test('fila: um por vez, remover pendente e cancelar o atual', async () => {
  const { app, page } = await launch(makeUserData({}))
  await mockDialogs(app, {
    open: [mediaFile('lento.mp3'), mediaFile('segundo.mp3'), mediaFile('terceiro.mp3')]
  })
  await page.getByRole('button', { name: 'Adicionar' }).click()
  const queue = page.getByRole('region', { name: /Fila/ })
  await expect(queue).toContainText('lento.mp3')
  await expect(page.getByRole('progressbar', { name: 'Progresso da transcrição' })).toBeVisible()

  await queue.getByRole('button', { name: 'Remover da fila' }).last().click()
  await expect(queue).not.toContainText('terceiro.mp3')

  await page.getByRole('button', { name: 'Cancelar transcrição' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancelar transcrição' }).click()
  const history = page.getByRole('region', { name: 'Histórico' })
  await expect(history).toContainText('Cancelado')
  await expect(history).toContainText('segundo.mp3') // o próximo rodou até o fim
  await expect(history.getByText('Concluído')).toBeVisible()
  await app.close()
})
