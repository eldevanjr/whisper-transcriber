// Funções puras do gerador de licenças (testadas em tests/scripts/licenses.test.ts).

const clean = (value) => (typeof value === 'string' && value !== 'UNKNOWN' ? value.trim() : '')

/** Saída JSON do license-checker-rseidelsohn (com licenseText via --customPath). */
export function fromLicenseChecker(report, ownName) {
  return Object.values(report)
    .filter((entry) => entry.name !== ownName)
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      license: Array.isArray(entry.licenses) ? entry.licenses.join(' OR ') : clean(entry.licenses),
      url: clean(entry.repository),
      text: clean(entry.licenseText)
    }))
}

/** Nome canônico de pacote Python (PEP 503): pip-licenses usa "_", o uv usa "-". */
export function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** Saída do pip-licenses (--format=json --with-license-file --with-urls), só pacotes de execução. */
export function fromPipLicenses(report, runtime) {
  return report
    .filter((entry) => runtime.has(normalizeName(entry.Name)))
    .map((entry) => ({
      name: entry.Name,
      version: entry.Version,
      license: clean(entry.License),
      url: clean(entry.URL),
      text: clean(entry.LicenseText)
    }))
}

const MIT_OPENAI = `MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/** Componentes que não vêm dos gerenciadores de pacotes, com as obrigações de cada um. */
export const FIXED_NOTICES = [
  {
    name: 'Electron',
    version: '',
    license: 'MIT',
    url: 'https://www.electronjs.org/',
    text: 'Copyright (c) Electron contributors\nCopyright (c) 2013-2020 GitHub Inc.\n\nLicenciado sob a licença MIT. O texto completo acompanha o aplicativo no arquivo LICENSE do Electron, na pasta de instalação.'
  },
  {
    name: 'Chromium',
    version: '',
    license: 'BSD-3-Clause e outras',
    url: 'https://www.chromium.org/',
    text: 'O Electron inclui o Chromium e suas dependências. Os avisos completos acompanham o aplicativo no arquivo LICENSES.chromium.html, na pasta de instalação.'
  },
  {
    name: 'FFmpeg',
    version: '',
    license: 'LGPL-2.1-or-later',
    url: 'https://ffmpeg.org/download.html',
    text: 'Este aplicativo usa bibliotecas do projeto FFmpeg (via PyAV), licenciadas sob a LGPL 2.1 ou posterior. O código-fonte do FFmpeg está disponível em https://ffmpeg.org/download.html. As bibliotecas são carregadas dinamicamente e podem ser substituídas.'
  },
  {
    name: 'Modelos Whisper (OpenAI)',
    version: '',
    license: 'MIT',
    url: 'https://huggingface.co/Systran',
    text: `Os pesos dos modelos Whisper foram publicados pela OpenAI sob a licença MIT e convertidos para CTranslate2 (Systran, mobiuslabsgmbh) e para GGML (whisper.cpp).\n\n${MIT_OPENAI}`
  },
  {
    name: 'whisper.cpp e ggml',
    version: '',
    license: 'MIT',
    url: 'https://github.com/ggml-org/whisper.cpp',
    text: 'Copyright (c) 2023-2026 The ggml authors\n\nMotor de transcrição por GPU (Vulkan/Metal), embutido no pywhispercpp. Licenciado sob a licença MIT (mesmo texto da licença acima, com os autores do ggml).'
  },
  {
    name: 'NVIDIA cuBLAS e cuDNN',
    version: '',
    license: 'NVIDIA EULA',
    url: 'https://docs.nvidia.com/cuda/eula/index.html',
    text: 'Baixadas somente se você ativar a GPU NVIDIA e aceitar os termos da NVIDIA. Não são distribuídas com o aplicativo.'
  }
]

export function mergeLicenses(groups) {
  return groups
    .flat()
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
        a.version.localeCompare(b.version)
    )
}

const COPYLEFT = /(^|[^L])A?GPL/i

/** Licenças proibidas num app Apache 2.0 distribuído: GPL/AGPL (LGPL liberada) e desconhecidas. */
export function findForbidden(entries) {
  return entries
    .filter((entry) => {
      if (entry.license === '' || entry.license === 'UNKNOWN') return true
      // "MIT OR GPL" deixa escolher a permissiva.
      return entry.license.split(/\s+OR\s+/).every((option) => COPYLEFT.test(option))
    })
    .map((entry) => `${entry.name}@${entry.version} (${entry.license || 'UNKNOWN'})`)
}
