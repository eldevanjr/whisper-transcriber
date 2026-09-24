// Motor falso e determinístico para os testes E2E: fala o protocolo JSON Lines do worker real.
// Nome do arquivo decide o roteiro: "ruim" → INVALID_MEDIA; "lento" → trechos devagar (para cancelar).
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
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

send({ type: 'ready', protocol: 2, version: VERSION })
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

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const { id, cmd, params } = JSON.parse(line)
  if (cmd === 'shutdown') process.exit(0)
  if (cmd === 'transcribe') void transcribe(id, params)
  else send({ type: 'result', id, data: cmd === 'self_test' ? { ok: true } : { loaded: true } })
})
lines.on('close', () => process.exit(0))
