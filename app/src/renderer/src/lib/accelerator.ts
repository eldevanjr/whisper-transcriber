export interface KeyInfo {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

// `code` é a tecla física: não muda com o layout nem com o Shift.
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code) || code === 'Space') return code
  return null
}

function modifiers(event: KeyInfo, platform: string): string[] {
  const mac = platform === 'darwin'
  return [
    (mac ? event.metaKey : event.ctrlKey) && 'CommandOrControl',
    mac && event.ctrlKey && 'Control',
    !mac && event.metaKey && 'Super',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift'
  ].filter((name): name is string => typeof name === 'string')
}

/** Teclas pressionadas → accelerator; 'pending' enquanto só há modificadores; null se não serve. */
export function acceleratorFromKeys(event: KeyInfo, platform: string): string | null {
  if (MODIFIER_KEYS.has(event.key)) return 'pending'
  const key = keyName(event.code)
  const mods = modifiers(event, platform)
  if (key === null || !mods.some((name) => name !== 'Shift')) return null
  return [...mods, key].join('+')
}
