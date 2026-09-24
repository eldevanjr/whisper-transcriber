const clamp = (value: number): number => Math.round(Math.min(100, Math.max(0, value)))

export function ProgressBar({ label, value }: { label: string; value: number }) {
  const pct = clamp(value)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded-full bg-line"
    >
      <div className="bg-gradient-accent h-full transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  )
}

const RADIUS = 52
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ProgressRing({ label, value }: { label: string; value: number }) {
  const pct = clamp(value)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="relative grid size-40 place-items-center"
    >
      <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="ring-gradient" x1="0" x2="1">
            <stop offset="0%" stopColor="#1D4ED8" />
            <stop offset="100%" stopColor="#60A5FA" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          stroke="url(#ring-gradient)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
        />
      </svg>
      <span className="text-3xl font-semibold tabular-nums">{pct}%</span>
    </div>
  )
}
