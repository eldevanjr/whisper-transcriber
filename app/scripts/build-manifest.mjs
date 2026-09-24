// Gera resources/downloads-manifest.json: revisões fixadas dos modelos (Hugging Face) e wheels
// NVIDIA (PyPI), com tamanho e SHA-256 de cada arquivo. Rode de novo só para atualizar versões.
// Uso: node scripts/build-manifest.mjs              (tudo)
//      node scripts/build-manifest.mjs --only ggml  (só os modelos do whisper.cpp; mantém o resto)
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const MODELS = {
  small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'large-v3': 'Systran/faster-whisper-large-v3'
}
// cuBLAS 12 + cuDNN 9 = o que o ctranslate2 4.x (faster-whisper 1.2) exige.
const CUDA_PACKAGES = [
  ['nvidia-cublas-cu12', '12.9.2.10'],
  ['nvidia-cudnn-cu12', '9.26.0.51']
]
const PLATFORM_TAGS = { 'win32-x64': 'win_amd64', 'linux-x64': 'manylinux_2_27_x86_64' }
// whisper.cpp: um arquivo ggml-<modelo>.bin por modelo, do repositório oficial.
const GGML_REPO = 'ggerganov/whisper.cpp'

async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function sha256Of(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const hash = createHash('sha256')
  for await (const chunk of response.body) hash.update(chunk)
  return hash.digest('hex')
}

async function model(repo) {
  const { sha: revision } = await getJson(`https://huggingface.co/api/models/${repo}`)
  const tree = await getJson(`https://huggingface.co/api/models/${repo}/tree/${revision}`)
  const files = []
  for (const entry of tree) {
    if (entry.type !== 'file' || entry.path.startsWith('.') || entry.path === 'README.md') continue
    const sha256 =
      entry.lfs?.oid ??
      (await sha256Of(`https://huggingface.co/${repo}/resolve/${revision}/${entry.path}`))
    files.push({ path: entry.path, size: entry.lfs?.size ?? entry.size, sha256 })
  }
  return { repo, revision, files }
}

async function wheel(name, version, tag) {
  const { urls } = await getJson(`https://pypi.org/pypi/${name}/${version}/json`)
  const file = urls.find((u) => u.filename.includes(tag))
  if (!file) throw new Error(`${name} ${version}: sem wheel ${tag}`)
  return { name: file.filename, url: file.url, size: file.size, sha256: file.digests.sha256 }
}

async function ggmlModels() {
  const { sha: revision } = await getJson(`https://huggingface.co/api/models/${GGML_REPO}`)
  const tree = await getJson(`https://huggingface.co/api/models/${GGML_REPO}/tree/${revision}`)
  const ggml = {}
  for (const id of Object.keys(MODELS)) {
    const entry = tree.find((file) => file.path === `ggml-${id}.bin`)
    if (!entry?.lfs) throw new Error(`${GGML_REPO}: sem ggml-${id}.bin`)
    ggml[id] = {
      repo: GGML_REPO,
      revision,
      files: [{ path: entry.path, size: entry.lfs.size, sha256: entry.lfs.oid }]
    }
    console.log(`ggml ${id}: ${entry.path} @ ${revision}`)
  }
  return ggml
}

const output = new URL('../resources/downloads-manifest.json', import.meta.url)
let manifest
if (process.argv.includes('--only') && process.argv.includes('ggml')) {
  manifest = { ...JSON.parse(await readFile(output, 'utf8')), ggml: await ggmlModels() }
} else {
  const models = {}
  for (const [id, repo] of Object.entries(MODELS)) {
    models[id] = await model(repo)
    console.log(`modelo ${id}: ${models[id].files.length} arquivos @ ${models[id].revision}`)
  }
  const cuda = {}
  for (const [target, tag] of Object.entries(PLATFORM_TAGS)) {
    cuda[target] = await Promise.all(CUDA_PACKAGES.map(([n, v]) => wheel(n, v, tag)))
    console.log(`cuda ${target}: ${cuda[target].map((w) => w.name).join(', ')}`)
  }
  manifest = { version: 1, models, ggml: await ggmlModels(), cuda }
}
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`gravado ${output.pathname}`)
