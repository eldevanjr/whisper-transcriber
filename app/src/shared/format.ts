import { toTranscriptEntry, type Segment, type TranscriptEntry } from './history'
import type { Track } from './settings'

export interface Paragraph {
  start: number
  end: number
  text: string
  falante?: Track
}

/** Rótulos traduzidos dos falantes do ao vivo ("Você", "Outros"). */
export type SpeakerLabels = Record<Track, string>

export const speakerPrefix = (
  falante: Track | undefined,
  labels: SpeakerLabels | undefined
): string => (falante && labels ? `${labels[falante]}: ` : '')

export const PARAGRAPH_PAUSE_S = 1.5
export const PARAGRAPH_MAX_CHARS = 600
const SENTENCE_END = /[.!?…]$/

const pad = (value: number): string => String(value).padStart(2, '0')

/** `mm:ss`, ou `hh:mm:ss` a partir de 1 h — igual ao CLI (trunca os segundos). */
export function formatTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = `${pad(minutes)}:${pad(total % 60)}`
  return hours > 0 ? `${pad(hours)}:${rest}` : rest
}

/** Idêntico ao `.txt` do CLI: `[inicio - fim] texto`, uma linha por trecho. */
export function toTimestamped(entries: readonly TranscriptEntry[], labels?: SpeakerLabels): string {
  return entries
    .map(
      (entry) =>
        `[${formatTime(entry.inicio)} - ${formatTime(entry.fim)}] ${speakerPrefix(entry.falante, labels)}${entry.texto}\n`
    )
    .join('')
}

// O Python escreve floats inteiros como "1.0"; o JSON do JS escreveria "1".
const pythonFloat = (value: number): string =>
  Number.isInteger(value) ? value.toFixed(1) : String(value)

/** Idêntico ao `.json` do CLI (`json.dumps(indent=4, ensure_ascii=False)`). */
export function toJson(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return '[]'
  const items = entries.map(
    (entry) =>
      `    {\n        "inicio": ${pythonFloat(entry.inicio)},\n        "fim": ${pythonFloat(entry.fim)},\n        "texto": ${JSON.stringify(entry.texto)}${entry.falante ? `,\n        "falante": "${entry.falante}"` : ''}\n    }`
  )
  return `[\n${items.join(',\n')}\n]`
}

export function segmentsToEntries(segments: readonly Segment[]): TranscriptEntry[] {
  return segments.map(toTranscriptEntry)
}

function startsNewParagraph(current: Paragraph, next: TranscriptEntry): boolean {
  if (next.falante !== current.falante) return true // ao vivo: cada falante no seu parágrafo
  if (next.inicio - current.end >= PARAGRAPH_PAUSE_S) return true
  return current.text.length > PARAGRAPH_MAX_CHARS && SENTENCE_END.test(current.text)
}

/** Parágrafos: quebra em pausa ≥ 1,5 s ou, passando de ~600 caracteres, no fim de uma frase. */
export function toParagraphs(entries: readonly TranscriptEntry[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  let current: Paragraph | null = null
  for (const entry of entries) {
    const text = entry.texto.trim()
    if (text === '') continue
    if (current !== null && !startsNewParagraph(current, entry)) {
      current.text = `${current.text} ${text}`
      current.end = entry.fim
    } else {
      current = newParagraph(entry, text)
      paragraphs.push(current)
    }
  }
  return paragraphs
}

function newParagraph(entry: TranscriptEntry, text: string): Paragraph {
  const paragraph: Paragraph = { start: entry.inicio, end: entry.fim, text }
  if (entry.falante) paragraph.falante = entry.falante
  return paragraph
}

export function paragraphsToText(paragraphs: readonly Paragraph[], labels?: SpeakerLabels): string {
  return paragraphs.map((p) => `${speakerPrefix(p.falante, labels)}${p.text}`).join('\n\n')
}
