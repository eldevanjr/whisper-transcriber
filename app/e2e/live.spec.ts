import { expect, test } from '@playwright/test'
import { launch, makeUserData } from './fixtures'

// Microfone falso do Chromium + worker falso (um trecho a cada 2 s de áudio).
test('ao vivo: testa, grava, encerra, refaz com o áudio completo e escolhe a versão', async () => {
  const { app, page } = await launch(
    makeUserData({ live: { micDeviceId: null, systemAudio: false, pauseS: 1 } })
  )
  await page.getByRole('button', { name: 'Ao vivo' }).click()
  await expect(page.getByRole('heading', { name: 'Ao vivo' })).toBeVisible()

  // O medidor mexe antes de começar: a captura (AudioWorklet) está de pé.
  const meter = page.getByRole('meter', { name: 'Nível: Você' })
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Testar' }).click()
  await expect(page.getByText('Bom dia a todos.')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Parar o teste' }).click()
  await expect(page.getByRole('button', { name: 'Testar' })).toBeVisible()

  await page.getByRole('button', { name: 'Iniciar' }).click()
  await expect(page.getByText('REC', { exact: true })).toBeVisible()
  const log = page.getByRole('log', { name: 'Conversa' })
  await expect(log.getByText('Hoje vamos falar sobre transcrição automática.')).toBeVisible({
    timeout: 10_000
  })
  await expect(log.getByText(/Você · 00:0/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Encerrar' }).click()

  // O item da sessão abre no histórico, com a transcrição ao vivo e o aviso para refazer.
  await expect(page.getByRole('heading', { name: /^Reunião / })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Trechos' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /Você.*Bom dia a todos\./ })).toBeVisible()
  const note = page.getByRole('note')
  await expect(note).toContainText('Transcrita ao vivo')
  await note.getByRole('button', { name: 'Refazer com o áudio completo' }).click()

  const versions = page.getByRole('radiogroup', { name: 'Versão' })
  await expect(versions).toBeVisible({ timeout: 10_000 })
  await expect(versions.getByRole('radio', { name: 'Refeita' })).toBeChecked()
  await expect(page.getByRole('button', { name: /Você.*Obrigado pela atenção\./ })).toBeVisible()
  await versions.getByText('Ao vivo').click()
  await expect(versions.getByRole('radio', { name: 'Ao vivo' })).toBeChecked()
  await expect(page.getByRole('button', { name: /Obrigado pela atenção\./ })).toBeHidden()
  await app.close()
})
