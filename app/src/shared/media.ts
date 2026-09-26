export type MediaKind = 'video' | 'audio'

export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm'] as const
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma'] as const

const KIND_BY_EXTENSION = new Map<string, MediaKind>([
  ...VIDEO_EXTENSIONS.map((ext): [string, MediaKind] => [ext, 'video']),
  ...AUDIO_EXTENSIONS.map((ext): [string, MediaKind] => [ext, 'audio'])
])

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma'
}

export function fileNameOf(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
}

function extensionOf(filePath: string): string {
  return (/\.([^.]+)$/.exec(fileNameOf(filePath))?.[1] ?? '').toLowerCase()
}

export function mediaKindOf(filePath: string): MediaKind | null {
  return KIND_BY_EXTENSION.get(extensionOf(filePath)) ?? null
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extensionOf(filePath)] ?? 'application/octet-stream'
}

/** Nome de arquivo sem separadores de pasta, caracteres proibidos no Windows nem de controle. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 200)
  return cleaned === '' ? 'transcricao.txt' : cleaned
}
