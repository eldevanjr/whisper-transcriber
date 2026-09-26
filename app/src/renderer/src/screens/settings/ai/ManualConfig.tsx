import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpManualConfig } from '../../../../../shared/mcp'
import { Button } from '../../../components/Button'
import { useCopy } from '../../../hooks/useCopy'

export interface ManualConfigProps {
  config: McpManualConfig
  /** Força aberto (ex.: erro do conector, spec §10.3). */
  open?: boolean
}

/** Config manual do cliente: expande o texto pronto e copia (spec §10.2). */
export function ManualConfig({ config, open = false }: ManualConfigProps) {
  const { t } = useTranslation()
  const { copied, copy } = useCopy()
  const [expanded, setExpanded] = useState(false)
  const isOpen = expanded || open
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={isOpen}
        className="self-start"
        onClick={() => {
          setExpanded(!isOpen)
        }}
      >
        <ChevronDown aria-hidden size={14} className={isOpen ? 'rotate-180' : ''} />
        {t('settings.ai.clients.manual')}
      </Button>
      {isOpen && (
        <div className="flex flex-col gap-2">
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2 p-3 text-xs">
            {config.text}
          </pre>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => void copy(config.text)}
          >
            {copied ? t('settings.ai.clients.copied') : t('settings.ai.clients.copy')}
          </Button>
        </div>
      )}
    </div>
  )
}
