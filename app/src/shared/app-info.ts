export const APP_NAME = 'Whisper Transcriber'
export const APP_AUTHOR = 'Eldevan Nery Junior'
export const AUTHOR_GITHUB_URL = 'https://github.com/eldevanjr'
export const REPOSITORY_URL = `${AUTHOR_GITHUB_URL}/whisper-transcriber`

export interface ThirdPartyLicense {
  name: string
  version: string
  license: string
  url: string
  text: string
}

/** Links dos projetos listados em Licenças: só esses (além da lista fixa) abrem no navegador. */
export function licenseUrls(licenses: readonly ThirdPartyLicense[]): Set<string> {
  const urls = new Set<string>()
  for (const { url } of licenses) {
    if (URL.canParse(url) && new URL(url).protocol === 'https:') urls.add(new URL(url).href)
  }
  return urls
}
