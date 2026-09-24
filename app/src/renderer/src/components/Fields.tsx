import { useId, type ReactNode } from 'react'

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
