/** Balão com a cauda num contorno só (mesmo desenho do ícone em build/icon.svg). */
export const BUBBLE =
  'M14 2 H34 A12 12 0 0 1 46 14 V30 A12 12 0 0 1 34 42 H24 L14 49 V42 A12 12 0 0 1 2 30 V14 A12 12 0 0 1 14 2 Z'

/** Onda sonora azul dentro de um balão: o logo do app. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 50" aria-hidden>
      <defs>
        <linearGradient id="logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1D4ED8" />
          <stop offset="100%" stopColor="#60A5FA" />
        </linearGradient>
      </defs>
      <path d={BUBBLE} fill="url(#logo-gradient)" />
      <g stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round">
        <line x1="13" y1="19" x2="13" y2="25" />
        <line x1="19" y1="14" x2="19" y2="30" />
        <line x1="25" y1="10" x2="25" y2="34" />
        <line x1="31" y1="15" x2="31" y2="29" />
        <line x1="37" y1="19" x2="37" y2="25" />
      </g>
    </svg>
  )
}
