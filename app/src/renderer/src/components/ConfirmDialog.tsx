import { useEffect, useId, useRef } from 'react'
import { Button } from './Button'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Diálogo modal de confirmação: foco inicial em Cancelar (seguro), Tab preso, Esc cancela. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const id = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const { open, onCancel } = props

  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      event.preventDefault()
      const target = document.activeElement === cancelRef.current ? confirmRef : cancelRef
      target.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-xl"
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {props.title}
        </h2>
        <p id={`${id}-message`} className="mt-2 text-sm text-muted">
          {props.message}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" onClick={props.onCancel}>
            {props.cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={props.destructive ? 'danger' : 'primary'}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
