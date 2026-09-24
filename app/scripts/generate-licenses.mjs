// Gera resources/third-party-licenses.json: dependências de produção do app (Node), pacotes de
// execução do worker (Python) e avisos fixos. Falha com GPL/AGPL ou licença desconhecida.
// Uso: pnpm gen:licenses          (grava)
//      pnpm gen:licenses --check  (só confere se o arquivo está atualizado — usado no CI)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIXED_NOTICES,
  findForbidden,
  fromLicenseChecker,
  fromPipLicenses,
  mergeLicenses,
  normalizeName
} from './licenses-lib.mjs'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORKER = join(APP, '..', 'worker')
const OUTPUT = join(APP, 'resources', 'third-party-licenses.json')

// Pacotes cuja licença o pip-licenses não informa, conferidas manualmente no repositório do projeto.
const OVERRIDES = {}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function nodeEntries() {
  const format = join(mkdtempSync(join(tmpdir(), 'wt-licenses-')), 'format.json')
  writeFileSync(
    format,
    JSON.stringify({ name: '', version: '', licenses: '', repository: '', licenseText: '' })
  )
  const report = run(
    'pnpm',
    ['exec', 'license-checker-rseidelsohn', '--production', '--json', '--customPath', format],
    APP
  )
  return fromLicenseChecker(JSON.parse(report), 'whisper-transcriber')
}

function pythonEntries() {
  const requirements = run('uv', ['export', '--no-dev', '--no-hashes', '--no-emit-project'], WORKER)
  const runtime = new Set(
    requirements
      .split('\n')
      .filter((line) => /^[A-Za-z0-9]/.test(line))
      .map((line) => normalizeName(line.split('==')[0].trim()))
  )
  const report = run(
    'uv',
    [
      'run',
      '--with',
      'pip-licenses',
      'pip-licenses',
      '--format=json',
      '--with-license-file',
      '--no-license-path',
      '--with-urls',
      '--from=mixed'
    ],
    WORKER
  )
  return fromPipLicenses(JSON.parse(report), runtime).map((entry) => ({
    ...entry,
    ...(OVERRIDES[normalizeName(entry.name)] ?? {})
  }))
}

const entries = mergeLicenses([nodeEntries(), pythonEntries(), FIXED_NOTICES])
const forbidden = findForbidden(entries)
if (forbidden.length > 0) {
  console.error(`Licenças não permitidas ou desconhecidas:\n  ${forbidden.join('\n  ')}`)
  process.exit(1)
}
const json = `${JSON.stringify(entries, null, 2)}\n`
if (process.argv.includes('--check')) {
  if (readFileSync(OUTPUT, 'utf8') !== json) {
    console.error(
      'third-party-licenses.json desatualizado: rode "pnpm gen:licenses" e faça commit.'
    )
    process.exit(1)
  }
  console.log(`third-party-licenses.json em dia (${entries.length} componentes)`)
} else {
  writeFileSync(OUTPUT, json)
  console.log(`${entries.length} componentes gravados em ${OUTPUT}`)
}
