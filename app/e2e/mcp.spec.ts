import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  appWindowTitles,
  connectMcp,
  killSpawnedApp,
  launch,
  makeUserData,
  slowMediaFile
} from './fixtures'

// Acesso ligado/desligado (spec §1.1); o conteúdo é lido do mesmo userData que o app usa.
const ENABLED = { mcp: { enabled: true, allowTranscribe: true } }
const DISABLED = { mcp: { enabled: false, allowTranscribe: true } }

interface ToolResult {
  isError?: boolean
  content: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface CurrentProgress {
  pct: number
  requested_by?: string
}

/** Observa `get_activity` até o job sair da fila; devolve os `pct` vistos em ordem. */
async function observeProgress(client: Client): Promise<number[]> {
  const pcts: number[] = []
  const deadline = Date.now() + 20_000
  let sawCurrent = false
  while (Date.now() < deadline) {
    const activity = await call(client, 'get_activity')
    const current = activity.structuredContent?.current as CurrentProgress | null | undefined
    if (current) {
      expect(current.requested_by).toBe('claude-code')
      sawCurrent = true
      pcts.push(current.pct)
      if (current.pct >= 100) break
    } else if (sawCurrent) {
      break // terminou e saiu da fila
    }
    await sleep(150)
  }
  return pcts
}

/** Lê `get_status` com `after` até `done`, concatenando os trechos (sem repetir). */
async function collectSegments(
  client: Client,
  id: string
): Promise<{ done: boolean; texts: string[] }> {
  const texts: string[] = []
  const deadline = Date.now() + 20_000
  let after = 0
  for (;;) {
    const status = await call(client, 'get_status', { id, after })
    const data = status.structuredContent as {
      segments: { text: string }[]
      next_after: number
      done: boolean
    }
    texts.push(...data.segments.map((segment) => segment.text))
    after = data.next_after
    if (data.done) return { done: true, texts }
    if (Date.now() >= deadline) return { done: false, texts }
    await sleep(150)
  }
}

test('app aberto: lista, transcreve, vê o % e os trechos e o selo "via" na barra lateral', async () => {
  const userData = makeUserData(ENABLED)
  const { app, page } = await launch(userData)
  const mcp = await connectMcp(userData)
  try {
    const empty = await call(mcp.client, 'list_transcriptions')
    expect(empty.isError).toBeFalsy()
    expect(empty.structuredContent?.total).toBe(0)

    const created = await call(mcp.client, 'transcribe_file', { path: slowMediaFile() })
    expect(created.isError).toBeFalsy()
    const id = String(created.structuredContent?.id)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    // get_activity: o job atual com o pct subindo (o motor falso manda um trecho a cada 1,5 s).
    const pcts = await observeProgress(mcp.client)
    expect(pcts.some((pct) => pct > 0)).toBe(true)
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b))

    // get_status: os trechos, sem repetir, até o fim.
    const { done, texts } = await collectSegments(mcp.client, id)
    expect(done).toBe(true)
    expect(texts).toContain('Bom dia a todos.')
    expect(texts).toContain('Obrigado pela atenção.')

    const text = await call(mcp.client, 'get_transcription', { id, format: 'text' })
    expect(String(text.structuredContent?.content)).toContain('Bom dia a todos. Hoje vamos falar')
    const json = await call(mcp.client, 'get_transcription', { id, format: 'json' })
    expect(String(json.structuredContent?.content)).toContain('"texto": "Bom dia a todos."')

    await expect(page.getByText('via Claude Code').first()).toBeVisible()
  } finally {
    await mcp.close()
    await app.close()
  }
})

test('app fechado: a leitura funciona e transcrever abre a janela e enfileira', async () => {
  const userData = makeUserData(ENABLED)
  const mcp = await connectMcp(userData)
  try {
    const empty = await call(mcp.client, 'list_transcriptions')
    expect(empty.structuredContent?.total).toBe(0)

    const created = await call(mcp.client, 'transcribe_file', { path: slowMediaFile() })
    expect(created.isError).toBeFalsy()
    const id = String(created.structuredContent?.id)

    // O app abriu sozinho: a janela aparece e a ponte passa a responder.
    await expect.poll(appWindowTitles, { timeout: 30_000 }).toContain('Whisper Transcriber')
    const activity = await call(mcp.client, 'get_activity')
    expect(activity.structuredContent?.app_running).toBe(true)

    const listed = await call(mcp.client, 'list_transcriptions')
    const items = listed.structuredContent?.items as { id: string }[]
    expect(items.map((item) => item.id)).toContain(id)
  } finally {
    await mcp.close()
    await killSpawnedApp(userData)
  }
})

test('acesso desligado: todas as ferramentas devolvem MCP_DISABLED', async () => {
  const userData = makeUserData(DISABLED)
  const mcp = await connectMcp(userData)
  try {
    const id = randomUUID()
    const calls: [string, Record<string, unknown>][] = [
      ['list_transcriptions', {}],
      ['search_transcriptions', { query: 'reuniao' }],
      ['get_transcription', { id }],
      ['get_audio', { id }],
      ['export_transcription', { id }],
      ['get_activity', {}],
      ['get_status', { id }],
      ['transcribe_file', { path: slowMediaFile() }]
    ]
    for (const [name, args] of calls) {
      const result = await call(mcp.client, name, args)
      expect(result.isError, name).toBe(true)
      expect(textOf(result), name).toContain('MCP_DISABLED')
      expect(textOf(result), name).toContain('AI access is turned off')
    }
  } finally {
    await mcp.close()
  }
})
