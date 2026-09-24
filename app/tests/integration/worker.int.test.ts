import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { resolveWorkerCommand, workerEnv } from '../../src/main/worker/locate'
import type { JobEvent } from '../../src/main/worker/protocol'
import { WorkerSupervisor } from '../../src/main/worker/supervisor'
import { AppError } from '../../src/shared/errors'
import { makeTempDir } from '../helpers/tmp'

const commandLine = resolveWorkerCommand({
  isPackaged: false,
  resourcesPath: '',
  appPath: join(__dirname, '..', '..'),
  platform: process.platform
})

function tinyModelDir(): string {
  const script =
    'from huggingface_hub import snapshot_download as s; print(s("Systran/faster-whisper-tiny"))'
  return execFileSync('uv', ['run', '--project', String(commandLine.cwd), 'python', '-c', script], {
    encoding: 'utf8'
  }).trim()
}

function sineWav(seconds: number, rate = 16000): Buffer {
  const samples = Math.round(seconds * rate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function supervisor(): WorkerSupervisor {
  return new WorkerSupervisor({
    spawn: (command, args, options) => spawn(command, [...args], { ...options, stdio: 'pipe' }),
    commandLine,
    envFor: (device) =>
      workerEnv(process.env, { platform: process.platform, device, cudaDir: '/nao-existe' }),
    expectedVersion: pkg.version,
    logger: console
  })
}

describe('worker real (contrato app ↔ worker)', () => {
  it('handshake com a mesma versão e erro tipado sem modelo', async () => {
    const worker = supervisor()
    await expect(worker.request({ cmd: 'self_test' })).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'MODEL_NOT_LOADED'
    )
    worker.dispose()
  })

  it('carrega o tiny, roda o autoteste e transcreve com eventos e áudio salvo', async () => {
    const worker = supervisor()
    const dir = await makeTempDir()
    const input = join(dir, 'três segundos.wav')
    await writeFile(input, sineWav(3))
    await worker.request({
      cmd: 'load_model',
      params: {
        model_dir: tinyModelDir(),
        device: 'cpu',
        engine: 'faster-whisper',
        compute_type: 'int8'
      }
    })
    await expect(worker.request({ cmd: 'self_test' })).resolves.toMatchObject({ ok: true })
    const events: JobEvent[] = []
    const audio = join(dir, 'history', 'job', 'audio.m4a')
    await worker.request(
      {
        cmd: 'transcribe',
        params: { job_id: 'job', input_path: input, language: 'pt', audio_out_path: audio }
      },
      { onEvent: (event) => events.push(event) }
    )
    expect(events.map((e) => e.type)).toContain('done')
    expect(existsSync(audio)).toBe(true)
    worker.dispose()
  })
})
