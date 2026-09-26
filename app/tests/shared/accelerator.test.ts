import { describe, expect, it } from 'vitest'
import { formatAccelerator, isAccelerator } from '../../src/shared/accelerator'

describe('isAccelerator', () => {
  it.each([
    'CommandOrControl+Alt+R',
    'Control+Shift+5',
    'Alt+F9',
    'Super+Space',
    'Command+Shift+F24'
  ])('aceita %s', (value) => {
    expect(isAccelerator(value)).toBe(true)
  })

  it.each([
    'R', // sem modificador: roubaria a tecla em todos os programas
    'Alt', // sem tecla
    'Shift+R', // só Shift: roubaria a letra maiúscula
    'Alt+Alt+R',
    'Hyper+R',
    'Alt+ç',
    'Alt+F25',
    ''
  ])('recusa %s', (value) => {
    expect(isAccelerator(value)).toBe(false)
  })
})

describe('formatAccelerator', () => {
  it('Windows/Linux: nomes com +', () => {
    expect(formatAccelerator('CommandOrControl+Alt+R', 'linux')).toBe('Ctrl+Alt+R')
    expect(formatAccelerator('Super+Shift+Space', 'win32')).toBe('Super+Shift+Space')
    expect(formatAccelerator('Command+Control+F2', 'linux')).toBe('Super+Ctrl+F2')
  })

  it('macOS: símbolos juntos', () => {
    expect(formatAccelerator('CommandOrControl+Alt+R', 'darwin')).toBe('⌘⌥R')
    expect(formatAccelerator('Control+Shift+Super+5', 'darwin')).toBe('⌃⇧⌘5')
    expect(formatAccelerator('Command+F1', 'darwin')).toBe('⌘F1')
  })
})
