export type MediaKind = 'video' | 'audio'

export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm'] as const
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wma'] as const

const KIND_BY_EXTENSION = new Map<string, MediaKind>([
  ...VIDEO_EXTENSIONS.map((ext): [string, MediaKind] => [ext, 'video']),
  ...AUDIO_EXTENSIONS.map((ext): [string, MediaKind] => [ext, 'audio'])
])

export function fileNameOf(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
}

export function mediaKindOf(filePath: string): MediaKind | null {
  const extension = /\.([^.]+)$/.exec(fileNameOf(filePath))?.[1] ?? ''
  return KIND_BY_EXTENSION.get(extension.toLowerCase()) ?? null
}
