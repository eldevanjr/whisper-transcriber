import { useTranslation } from 'react-i18next'
import { BUBBLE } from './Logo'

const BARS: [number, number, number][] = [
  [13, 19, 25],
  [19, 14, 30],
  [25, 10, 34],
  [31, 15, 29],
  [37, 19, 25]
]

/**
 * Mesma marcação da tela de carregamento do index.html (os estilos `.boot*` ficam lá, no
 * <head>): enquanto o estado do main não chega, a troca do HTML para o React não pisca.
 */
export function BootSplash() {
  const { t } = useTranslation()
  return (
    <div className="boot" role="status">
      <div className="boot-card">
        <svg className="boot-logo" viewBox="0 0 48 50" aria-hidden>
          <defs>
            <linearGradient id="boot-gradient-react" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1D4ED8" />
              <stop offset="100%" stopColor="#60A5FA" />
            </linearGradient>
          </defs>
          <path d={BUBBLE} fill="url(#boot-gradient-react)" />
          <g stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round">
            {BARS.map(([x, y1, y2]) => (
              <line key={x} className="boot-bar" x1={x} y1={y1} x2={x} y2={y2} />
            ))}
          </g>
        </svg>
        <p className="boot-name">{t('app.name')}</p>
        <div className="boot-progress" />
        <p className="boot-status">{t('app.loading')}</p>
      </div>
    </div>
  )
}
