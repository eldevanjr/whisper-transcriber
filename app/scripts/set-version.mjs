// Versão única (spec §10.5): o CI grava a versão calculada pelo semantic-release nas três fontes
// antes do build, sem commit de volta. No repositório fica 0.0.0-dev.
// Uso: node scripts/set-version.mjs 1.2.3
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const PEP440_PRE = { dev: 'dev', alpha: 'a', beta: 'b', rc: 'rc' }

/** 1.2.3 → 1.2.3; 0.0.0-dev → 0.0.0.dev0; 1.0.0-rc.1 → 1.0.0rc1 (formato do pyproject). */
export function pep440(version) {
  const [core, pre] = version.split('-')
  if (!pre) return core
  const match = /^(dev|alpha|beta|rc)\.?(\d+)?$/.exec(pre)
  if (!match || (match[1] !== 'dev' && !match[2]))
    throw new Error(`pré-release sem PEP 440: ${pre}`)
  const tag = PEP440_PRE[match[1]]
  return tag === 'dev' ? `${core}.dev${match[2] ?? 0}` : `${core}${tag}${match[2]}`
}

export function applyVersion(sources, version) {
  if (!SEMVER.test(version)) throw new Error(`versão fora do SemVer: ${version}`)
  const pkg = JSON.parse(sources.packageJson)
  pkg.version = version
  return {
    packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    // Só a chave do [project] (a primeira "version = " no início da linha).
    pyproject: sources.pyproject.replace(/^version = ".*"$/m, `version = "${pep440(version)}"`),
    init: sources.init.replace(/^__version__ = ".*"$/m, `__version__ = "${version}"`)
  }
}

const FILES = {
  packageJson: 'app/package.json',
  pyproject: 'worker/pyproject.toml',
  init: 'worker/transcriber_worker/__init__.py'
}

export async function setVersion(root, version) {
  const entries = Object.entries(FILES)
  const texts = await Promise.all(entries.map(([, file]) => readFile(join(root, file), 'utf-8')))
  const updated = applyVersion(
    Object.fromEntries(entries.map(([key], i) => [key, texts[i]])),
    version
  )
  await Promise.all(entries.map(([key, file]) => writeFile(join(root, file), updated[key])))
}

/* c8 ignore next 4 -- ponto de entrada da linha de comando */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(import.meta.dirname, '..', '..')
  await setVersion(root, process.argv[2] ?? '')
}
