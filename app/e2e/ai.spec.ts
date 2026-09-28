import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launch, makeUserData, mediaFile, mockDialogs } from './fixtures'

async function enableLocalAi(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Configurações' }).click()
  await page.getByRole('button', { name: 'IA local' }).click()
  await page.getByRole('switch', { name: 'Usar IA local (Ollama)' }).click()
  await expect(page.getByRole('switch', { name: 'Usar IA local (Ollama)' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await page.getByRole('button', { name: 'Voltar' }).click()
}

test('transcreve, mostra a análise na aba Inteligência e abre a fonte', async () => {
  const { app, page } = await launch(makeUserData({}))
  await mockDialogs(app, { open: [mediaFile('reuniao.mp3')] })
  await enableLocalAi(page)

  await page.getByRole('button', { name: 'Escolher vídeo ou áudio' }).click()
  await expect(page.getByRole('button', { name: /Obrigado pela atenção\./ })).toBeVisible()

  await page.getByRole('tab', { name: 'Inteligência' }).click()
  await expect(page.getByText('Análise: 0 pendentes · Indexação: 100%')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tópicos' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tarefas' })).toBeVisible()

  // "Abrir a fonte": o horário da entidade pula o player para o trecho.
  await page.getByRole('button', { name: /Sincronização/ }).click()
  await expect
    .poll(() => page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1))
    .toBeGreaterThan(0)

  // Pergunta ao conhecimento (RAG) com a fonte.
  await page.getByLabel('Pergunte sobre suas transcrições').fill('O que foi falado?')
  await page.getByRole('button', { name: 'Perguntar' }).click()
  await expect(page.getByText('Falaram da sincronização [3.0s-6.0s].')).toBeVisible()
  await expect(page.getByText(/Reunião anterior/)).toBeVisible()

  await app.close()
})

test('diagnóstico e reindexação na seção IA local', async () => {
  const { app, page } = await launch(makeUserData({}))
  await enableLocalAi(page)

  await page.getByRole('button', { name: 'Configurações' }).click()
  await page.getByRole('button', { name: 'IA local' }).click()

  await page.getByRole('button', { name: 'Executar diagnóstico' }).click()
  const list = page.getByRole('list', { name: 'Diagnóstico' })
  await expect(list.getByText('Ollama')).toBeVisible()
  await expect(list.getByText('pgvector')).toBeVisible()

  await page.getByRole('button', { name: 'Reindexar conhecimento' }).click()
  await expect(page.getByText('1 itens reindexados.')).toBeVisible()

  await app.close()
})

test('backup, restauração e download de modelo', async () => {
  const { app, page } = await launch(makeUserData({}))
  const dir = await mkdtemp(join(tmpdir(), 'wt-ai-backup-'))
  const backupPath = join(dir, 'conhecimento.json')
  await mockDialogs(app, { save: backupPath, open: [backupPath] })
  await enableLocalAi(page)

  await page.getByRole('button', { name: 'Configurações' }).click()
  await page.getByRole('button', { name: 'IA local' }).click()

  await page.getByRole('button', { name: 'Fazer backup' }).click()
  await expect(page.getByText('Backup: 2 documentos, 1 análises.')).toBeVisible()

  await page.getByRole('button', { name: 'Restaurar' }).click()
  await expect(page.getByText('2 documentos e 1 análises restaurados.')).toBeVisible()

  await page.getByRole('button', { name: 'Baixar modelo' }).first().click()
  await expect(page.getByText('qwen3:8b pronto.')).toBeVisible()

  await app.close()
})
