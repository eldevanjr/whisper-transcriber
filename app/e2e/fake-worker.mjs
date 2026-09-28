// Motor falso e determinístico para os testes E2E: fala o protocolo JSON Lines do worker real.
// Nome do arquivo decide o roteiro: "ruim" → INVALID_MEDIA; "lento" → trechos devagar (para cancelar).
// Ao vivo: a cada 2 s de áudio de uma faixa sai um trecho; ao finalizar, as faixas viram m4a.
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Mesma versão do app (o handshake recusa versões diferentes); o CI grava a do release.
const APP_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version
const VERSION = process.env.WT_FAKE_WORKER_VERSION ?? APP_VERSION
const AUDIO = join(HERE, 'fixtures', 'silence.m4a')
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

send({ type: 'ready', protocol: 4, version: VERSION })
setInterval(() => send({ type: 'heartbeat' }), 2000).unref()

const SEGMENTS = [
  'Bom dia a todos.',
  'Hoje vamos falar sobre transcrição automática.',
  'O Whisper reconhece a fala e gera o texto.',
  'Obrigado pela atenção.'
]

async function transcribe(id, params) {
  const job = params.job_id
  if (params.input_path.includes('ruim')) {
    send({ type: 'error', id, job_id: job, code: 'INVALID_MEDIA', message: 'arquivo ilegível' })
    return
  }
  const delay = params.input_path.includes('lento') ? 1500 : 150
  send({ type: 'phase', phase: 'extracting_audio', job_id: job })
  if (existsSync(AUDIO)) copyFileSync(AUDIO, params.audio_out_path)
  send({ type: 'phase', phase: 'transcribing', job_id: job })
  const total = SEGMENTS.length * 3
  for (const [index, text] of SEGMENTS.entries()) {
    await sleep(delay)
    const start = index * 3
    send({ type: 'segment', job_id: job, index, start, end: start + 2.5, text })
    const processed = start + 3
    send({
      type: 'progress',
      job_id: job,
      pct: (processed / total) * 100,
      processed_s: processed,
      total_s: total,
      speed: 4
    })
  }
  send({ type: 'done', job_id: job, duration: total, language_detected: 'pt' })
  send({ type: 'result', id, data: { segments: SEGMENTS.length } })
}

const LIVE_BLOCKS = 20 // 20 blocos de 100 ms = 2 s por trecho
let live = null

function liveAudio({ session_id, track, seq }) {
  if (live?.id !== session_id) return
  const count = (live.blocks[track] = (live.blocks[track] ?? 0) + 1)
  if (count === 1) send({ type: 'live_listening', session_id, track, active: true })
  if (count % LIVE_BLOCKS !== 0) return
  const text = SEGMENTS[live.segments % SEGMENTS.length]
  live.segments += 1
  const end = (seq + 1) / 10
  send({ type: 'live_segment', session_id, track, start: end - 2, end, text })
}

function liveFinalize({ dir, tracks }) {
  const durations = {}
  for (const track of tracks) {
    rmSync(join(dir, `live-${track}.wav`), { force: true })
    copyFileSync(AUDIO, join(dir, `${track}.m4a`))
    durations[track] = 6
  }
  copyFileSync(AUDIO, join(dir, 'audio.m4a'))
  return { durations }
}

function liveCommand(id, cmd, params) {
  if (cmd === 'live_audio') return liveAudio(params) // sem resposta, como o worker real
  if (cmd === 'live_start') live = { id: params.session_id, blocks: {}, segments: 0 }
  let data = {}
  if (cmd === 'live_stop') {
    for (const track of Object.keys(live?.blocks ?? {})) {
      send({ type: 'live_listening', session_id: params.session_id, track, active: false })
    }
    data = { segments: live?.segments ?? 0 }
    live = null
  }
  if (cmd === 'live_finalize') data = liveFinalize(params)
  send({ type: 'result', id, data })
}

// IA local falsa: status sempre ligado e uma análise fixa com tempos para "abrir a fonte".
const AI_ANALYSIS = {
  model: 'fake',
  topics: [
    {
      id: 't1',
      name: 'Sincronização',
      description: 'como manter tudo em dia',
      confidence: 0.9,
      source_segments: [{ segment_index: 0, start: 3, end: 6 }]
    }
  ],
  tasks: [
    {
      id: 'k1',
      description: 'Corrigir o áudio',
      confidence: 0.5,
      source_segments: [{ segment_index: 1, start: 6, end: 9 }]
    }
  ]
}

const AI = {
  configure_ai: () => ({}),
  ai_status: () => ({
    status: {
      configured: true,
      enabled: true,
      analysis: {},
      index: { COMPLETED: 4 },
      storage: { kind: 'sqlite', fallback: false, reason: null },
      blocked: null,
      reindex_required: false
    }
  }),
  analysis_submit: () => ({ analysis: 1, chunks: 1 }),
  analysis_append: () => ({ analysis: 0 }),
  analysis_retry: () => ({ retried: 0 }),
  knowledge_reindex_cancel: () => ({ canceled: 0 }),
  knowledge_delete: (params) => ({ deleted: params.transcription_id }),
  knowledge_search: () => ({ results: [] }),
  knowledge_ask: () => ({
    answer: 'Falaram da sincronização [3.0s-6.0s].',
    model: 'fake',
    sources: [
      {
        chunk: {
          content: 'Obrigado pela atenção.',
          metadata: { transcription_id: 'outra', start_time: 3, end_time: 6 }
        },
        score: 0.9,
        source: { title: 'Reunião anterior' }
      }
    ]
  }),
  analysis_process: () => ({ analysis: 0, index: 0 }),
  analysis_finalize: () => ({ result: AI_ANALYSIS }),
  analysis_get: () => ({ analysis: AI_ANALYSIS }),
  knowledge_reindex: () => ({ enqueued: 1 }),
  knowledge_backup: () => ({ documents: 2, chunks: 3, analyses: 1 }),
  knowledge_restore: () => ({ documents: 2, chunks: 3, analyses: 1, enqueued: 0 }),
  ai_pull_model: (params) => ({ model: params.model }),
  ai_diagnose: () => ({
    diagnostics: {
      checks: [
        { name: 'ollama', ok: true, detail: 'http://localhost:11434 · 2 modelos' },
        { name: 'llm', ok: true, detail: 'qwen3:8b' },
        { name: 'pgvector', ok: false, detail: 'não conectado' }
      ]
    }
  })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const { id, cmd, params } = JSON.parse(line)
  if (cmd === 'shutdown') process.exit(0)
  if (cmd === 'transcribe') void transcribe(id, params)
  else if (cmd.startsWith('live_')) liveCommand(id, cmd, params)
  else if (AI[cmd]) send({ type: 'result', id, data: AI[cmd](params) })
  else send({ type: 'result', id, data: cmd === 'self_test' ? { ok: true } : { loaded: true } })
})
lines.on('close', () => process.exit(0))
