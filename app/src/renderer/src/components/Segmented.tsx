import { useId } from 'react'

/** Escolha curta entre poucas opções (botões lado a lado), acessível como grupo de rádios. */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const name = useId()
  return (
    <div className="flex items-center gap-2 text-sm">
      <span id={`${name}-label`} className="text-muted">
        {props.label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${name}-label`}
        className="inline-flex rounded-lg border border-line bg-surface p-0.5"
      >
        {props.options.map((option) => (
          <label
            key={option.value}
            className="cursor-pointer rounded-md px-3 py-1 has-checked:bg-accent-soft has-checked:font-medium has-checked:text-accent has-focus-visible:ring-2 has-focus-visible:ring-accent"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => {
                props.onChange(option.value)
              }}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  )
}
