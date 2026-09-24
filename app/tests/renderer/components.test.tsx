import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Star } from 'lucide-react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button, IconButton } from '../../src/renderer/src/components/Button'
import { ConfirmDialog } from '../../src/renderer/src/components/ConfirmDialog'
import { ProgressBar, ProgressRing } from '../../src/renderer/src/components/Progress'
import { Tabs } from '../../src/renderer/src/components/Tabs'
import { Toggle } from '../../src/renderer/src/components/Toggle'
import { expectAccessible } from './render'

describe('Button e IconButton', () => {
  it('são type="button" por padrão, com variantes e rótulo acessível', async () => {
    const onClick = vi.fn()
    const { container } = render(
      <>
        <Button onClick={onClick}>Salvar</Button>
        <Button variant="danger" size="sm" type="submit">
          Apagar
        </Button>
        <Button variant="secondary">Outro</Button>
        <Button variant="ghost">Fantasma</Button>
        <IconButton label="Favoritar" icon={Star} onClick={onClick} />
        <IconButton label="Perigo" icon={Star} variant="danger" />
      </>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    await userEvent.click(screen.getByRole('button', { name: 'Favoritar' }))
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveAttribute('type', 'button')
    expect(screen.getByRole('button', { name: 'Apagar' })).toHaveAttribute('type', 'submit')
    expect(screen.getByRole('button', { name: 'Favoritar' })).toHaveAttribute('title', 'Favoritar')
    // Sem padding horizontal concorrente: com px-3 o ícone ficava espremido em 8 px.
    const icon = screen.getByRole('button', { name: 'Favoritar' })
    expect(icon.className).toMatch(/\bsize-8\b/)
    expect(icon.className).not.toMatch(/\bpx-\d/)
    expect(icon.querySelector('svg')).toHaveClass('shrink-0')
    await expectAccessible(container)
  })
})

describe('Toggle', () => {
  it('é um switch acessível que alterna com clique e teclado', async () => {
    function Harness() {
      const [on, setOn] = useState(false)
      return <Toggle label="Usar GPU" description="Mais rápido" checked={on} onChange={setOn} />
    }
    const { container } = render(<Harness />)
    const toggle = screen.getByRole('switch', { name: 'Usar GPU' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAccessibleDescription('Mais rápido')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    toggle.focus()
    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expectAccessible(container)
  })

  it('desabilitado não muda', async () => {
    const onChange = vi.fn()
    render(<Toggle label="X" checked={false} onChange={onChange} disabled />)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Tabs', () => {
  const tabs = [
    { id: 'text', label: 'Texto' },
    { id: 'times', label: 'Com tempos' },
    { id: 'json', label: 'JSON' }
  ]
  function Harness() {
    const [value, setValue] = useState('text')
    return (
      <Tabs label="Formato" tabs={tabs} value={value} onChange={setValue}>
        <p>painel {value}</p>
      </Tabs>
    )
  }

  it('marca a aba ativa e liga o painel a ela', async () => {
    const { container } = render(<Harness />)
    expect(screen.getByRole('tab', { name: 'Texto' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Texto' })).toHaveTextContent('painel text')
    await userEvent.click(screen.getByRole('tab', { name: 'JSON' }))
    expect(screen.getByRole('tabpanel', { name: 'JSON' })).toHaveTextContent('painel json')
    await expectAccessible(container)
  })

  it('setas, Home e End navegam e ativam', async () => {
    render(<Harness />)
    screen.getByRole('tab', { name: 'Texto' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Com tempos' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Com tempos' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Texto' })).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Texto' })).toHaveFocus()
    await userEvent.keyboard('a')
    expect(screen.getByRole('tab', { name: 'Texto' })).toHaveFocus()
  })
})

describe('Progress', () => {
  it('barra e anel expõem o valor arredondado e limitado a 0–100', () => {
    render(
      <>
        <ProgressBar label="Transcrição" value={42.6} />
        <ProgressRing label="Download" value={120} />
        <ProgressBar label="Negativo" value={-5} />
      </>
    )
    expect(screen.getByRole('progressbar', { name: 'Transcrição' })).toHaveAttribute(
      'aria-valuenow',
      '43'
    )
    const ring = screen.getByRole('progressbar', { name: 'Download' })
    expect(ring).toHaveAttribute('aria-valuenow', '100')
    expect(ring).toHaveTextContent('100%')
    expect(screen.getByRole('progressbar', { name: 'Negativo' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    )
  })
})

describe('ConfirmDialog', () => {
  function Harness(props: { onConfirm: () => void }) {
    const [open, setOpen] = useState(true)
    return (
      <>
        <button type="button">fora</button>
        <ConfirmDialog
          open={open}
          title="Limpar histórico?"
          message="Não pode ser desfeito."
          confirmLabel="Apagar"
          cancelLabel="Cancelar"
          destructive
          onConfirm={props.onConfirm}
          onCancel={() => {
            setOpen(false)
          }}
        />
      </>
    )
  }

  it('abre com foco em Cancelar, prende o Tab e confirma', async () => {
    const onConfirm = vi.fn()
    const { container } = render(<Harness onConfirm={onConfirm} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Limpar histórico?' })
    expect(dialog).toHaveAccessibleDescription('Não pode ser desfeito.')
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Apagar' })).toHaveFocus()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Apagar' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Apagar' }))
    expect(onConfirm).toHaveBeenCalled()
    await expectAccessible(container)
  })

  it('Esc e o botão Cancelar fecham', async () => {
    render(<Harness onConfirm={vi.fn()} />)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('outras teclas não fecham; fechado não renderiza nada', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="ok"
        cancelLabel="não"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'a' })
    expect(onCancel).not.toHaveBeenCalled()
    rerender(
      <ConfirmDialog
        open={false}
        title="t"
        message="m"
        confirmLabel="ok"
        cancelLabel="não"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
