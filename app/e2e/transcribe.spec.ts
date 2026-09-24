import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { clipboardText, launch, makeUserData, mediaFile, mockDialogs, tempDir } from './fixtures'

test('transcreve com trechos ao vivo, mostra as 4 abas, copia e baixa', async () => {
  const { app, page } = await launch(makeUserData({}))
  const saved = join(tempDir(), 'saida.txt')
  await mockDialogs(app, { open: [mediaFile('aula 01.mp3')], save: saved })

  await page.getByRole('button', { name: 'Escolher vídeo ou áudio' }).click()
  await expect(page.getByRole('button', { name: /Bom dia a todos\./ })).toBeVisible()
  // Ao terminar, a aba Trechos (os mesmos balões da transcrição ao vivo) vem aberta.
  await expect(page.getByRole('tab', { name: 'Trechos' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /Obrigado pela atenção\./ })).toBeVisible()
  // O áudio só existe depois da extração: o player tem de recarregar ao concluir.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.readyState ?? -1))
    .toBeGreaterThan(0)
  await expect(page.getByText('A mídia ainda não está disponível.')).toBeHidden()

  const gear = await page
    .getByRole('button', { name: 'Configurações' })
    .locator('svg')
    .boundingBox()
  expect(gear?.width).toBe(16) // ícone não pode ficar espremido
  await page.getByRole('tab', { name: 'Texto' }).click()
  await page.getByRole('button', { name: 'Copiar' }).click()
  await expect(page.getByRole('button', { name: '✓ Copiado' })).toBeVisible()
  expect(await clipboardText(app)).toContain('Bom dia a todos. Hoje vamos falar')

  await page.getByRole('tab', { name: 'Com tempos' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('[00:00 - 00:02] Bom dia a todos.')
  await page.getByRole('tab', { name: 'JSON' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('"texto": "Bom dia a todos."')

  await page.getByRole('tab', { name: 'Com tempos' }).click()
  await page.getByRole('button', { name: 'Baixar' }).click()
  await expect(page.getByText('Arquivo salvo.')).toBeVisible()
  expect(readFileSync(saved, 'utf8')).toMatch(/^\[00:00 - 00:02\] Bom dia a todos\.\n/)
  await app.close()
})

test('arquivo ilegível mostra o erro traduzido com "Transcrever de novo"', async () => {
  const { app, page } = await launch(makeUserData({}))
  await mockDialogs(app, { open: [mediaFile('ruim.mp4')] })
  await page.getByRole('button', { name: 'Adicionar' }).click()
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^ruim\.mp4/ })
    .click()
  await expect(page.getByRole('alert')).toContainText('Não foi possível ler este arquivo.')
  await expect(page.getByRole('button', { name: 'Transcrever de novo' }).first()).toBeVisible()
  await app.close()
})
