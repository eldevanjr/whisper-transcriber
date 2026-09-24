import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface TabItem {
  id: string
  label: string
}

export interface TabsProps {
  label: string
  tabs: readonly TabItem[]
  value: string
  onChange: (id: string) => void
  children: ReactNode
  actions?: ReactNode
}

const KEY_STEP: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1
}

export function Tabs({ label, tabs, value, onChange, children, actions }: TabsProps) {
  const id = useId()
  const refs = useRef(new Map<string, HTMLButtonElement>())

  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const step = KEY_STEP[event.key]
    if (!step) return
    event.preventDefault()
    const target = step(index, tabs.length)
    for (const [position, tab] of tabs.entries()) {
      if (position !== target) continue
      onChange(tab.id)
      refs.current.get(tab.id)?.focus()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-line px-3">
        <div role="tablist" aria-label={label} className="flex gap-1">
          {tabs.map((tab, index) => {
            const selected = tab.id === value
            return (
              <button
                key={tab.id}
                ref={(element) => {
                  if (element) refs.current.set(tab.id, element)
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  onChange(tab.id)
                }}
                onKeyDown={(event) => {
                  onKeyDown(event, index)
                }}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${selected ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-fg'}`}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        {actions}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${value}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto"
      >
        {children}
      </div>
    </div>
  )
}
