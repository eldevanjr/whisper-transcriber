import type { LucideIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-solid text-on-accent hover:bg-accent-solid-hover',
  secondary: 'border border-line bg-surface text-fg hover:bg-surface-2',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-danger-soft text-danger hover:brightness-95'
}

const SIZES = { md: 'h-10 px-4 text-sm', sm: 'h-8 px-3 text-xs', icon: 'size-8' } as const

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant
  size?: keyof typeof SIZES
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    />
  )
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  label: string
  icon: LucideIcon
}

export function IconButton({ label, icon: Icon, variant = 'ghost', ...rest }: IconButtonProps) {
  return (
    <Button
      variant={variant}
      size="icon"
      aria-label={label}
      title={label}
      className="shrink-0"
      {...rest}
    >
      <Icon aria-hidden size={16} className="shrink-0" />
    </Button>
  )
}
