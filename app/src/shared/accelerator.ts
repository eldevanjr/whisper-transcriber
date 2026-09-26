const MODIFIERS: ReadonlySet<string> = new Set([
  'CommandOrControl',
  'Command',
  'Control',
  'Alt',
  'Shift',
  'Super'
])
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space)$/

/**
 * Accelerator do Electron para atalho global: modificadores sem repetir, pelo menos um que não
 * seja Shift (só Shift roubaria as maiúsculas de todos os programas) e uma tecla no fim.
 */
export function isAccelerator(value: string): boolean {
  const [key, ...modifiers] = value.split('+').reverse()
  return (
    KEY.test(String(key)) &&
    modifiers.some((part) => part !== 'Shift') &&
    new Set(modifiers).size === modifiers.length &&
    modifiers.every((part) => MODIFIERS.has(part))
  )
}

const MAC_NAMES: Record<string, string> = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Super: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧'
}
const PC_NAMES: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  Control: 'Ctrl',
  Command: 'Super',
  Super: 'Super',
  Alt: 'Alt',
  Shift: 'Shift'
}

/** Para mostrar: "Ctrl+Alt+R" no Windows/Linux, "⌘⌥R" no macOS. */
export function formatAccelerator(value: string, platform: string): string {
  const mac = platform === 'darwin'
  const names = mac ? MAC_NAMES : PC_NAMES
  return value
    .split('+')
    .map((part) => names[part] ?? part)
    .join(mac ? '' : '+')
}
