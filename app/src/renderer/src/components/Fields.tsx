import { useId, useState, type ReactNode } from 'react'

export interface Option<T extends string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
  hint?: string
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      <select
        id={id}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value as T)
        }}
        className="h-10 max-w-sm rounded-lg border border-line bg-surface px-3 text-sm"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint && <p className="text-xs text-muted">{props.hint}</p>}
    </div>
  )
}

export function RadioGroup<T extends string>(props: {
  label: string
  name: string
  value: T
  options: readonly Option<T>[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{props.label}</legend>
      <div className="flex flex-wrap gap-2">
        {props.options.map((option) => (
          <label
            key={option.value}
            className={`flex min-w-32 cursor-pointer flex-col rounded-lg border border-line bg-surface px-3 py-2 text-sm has-checked:border-accent has-checked:bg-accent-soft ${option.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={props.name}
                value={option.value}
                checked={props.value === option.value}
                disabled={option.disabled}
                onChange={() => {
                  props.onChange(option.value)
                }}
              />
              {option.label}
            </span>
            {option.hint && <span className="text-xs text-muted">{option.hint}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function TextField(props: {
  label: string
  value: string | number
  onChange: (value: string) => void
  hint?: string
  type: 'text' | 'password'
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      <input
        id={id}
        type={props.type}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value)
        }}
        className="h-10 max-w-sm rounded-lg border border-line bg-surface px-3 text-sm"
      />
      {props.hint && <p className="text-xs text-muted">{props.hint}</p>}
    </div>
  )
}

/**
 * Campo que só salva ao confirmar (sair do campo ou Enter): apagar para redigitar
 * ou passar por valores intermediários ("6" antes de "60") não salva nada. O erro
 * de validação aparece no próprio campo; Esc volta ao valor salvo.
 */
export function CommitField(props: {
  label: string
  value: string | number
  onCommit: (value: string) => void
  /** Mensagem de erro para o texto digitado, ou null se válido. */
  validate?: (raw: string) => string | null
  hint?: string
  type?: 'text' | 'number'
  min?: number
  step?: number
}) {
  const id = useId()
  const saved = String(props.value)
  const [draft, setDraft] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  // Valor salvo mudou por fora (ou após salvar): o campo acompanha.
  const [shown, setShown] = useState(saved)
  if (shown !== saved) {
    setShown(saved)
    setDraft(saved)
    setError(null)
  }

  const commit = (): void => {
    if (draft === saved) {
      setError(null)
      return
    }
    const problem = props.validate?.(draft) ?? null
    setError(problem)
    if (problem === null) props.onCommit(draft)
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {props.label}
      </label>
      <input
        id={id}
        type={props.type ?? 'text'}
        value={draft}
        min={props.min}
        step={props.step}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? `${id}-error` : undefined}
        onChange={(event) => {
          setDraft(event.target.value)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            setDraft(saved)
            setError(null)
          }
        }}
        className="h-10 max-w-sm rounded-lg border border-line bg-surface px-3 text-sm aria-invalid:border-danger"
      />
      {error !== null && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {props.hint && <p className="text-xs text-muted">{props.hint}</p>}
    </div>
  )
}

export function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5"
    >
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}
