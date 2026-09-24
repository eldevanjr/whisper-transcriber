import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import licenses from '../../../../../resources/third-party-licenses.json'
import type { ThirdPartyLicense } from '../../../../shared/app-info'
import { Button } from '../../components/Button'
import { useApi } from '../../providers'

const ALL: readonly ThirdPartyLicense[] = licenses

function Detail({ entry, onBack }: { entry: ThirdPartyLicense; onBack: () => void }) {
  const { t } = useTranslation()
  const api = useApi()
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          {t('settings.licenses.backToList')}
        </Button>
      </div>
      <h2 className="text-lg font-semibold">{entry.name}</h2>
      <p className="text-sm text-muted">
        {[entry.version, entry.license].filter((part) => part !== '').join(' · ')}
      </p>
      {entry.url !== '' && (
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void api.system.openExternal(entry.url)}
          >
            {t('settings.licenses.openPage')}
          </Button>
        </div>
      )}
      {entry.text !== '' && (
        <pre className="max-h-[50vh] overflow-auto rounded-lg bg-surface-2 p-4 text-xs whitespace-pre-wrap">
          {entry.text}
        </pre>
      )}
    </article>
  )
}

export function LicensesSection() {
  const { t } = useTranslation()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ThirdPartyLicense | null>(null)
  if (selected) {
    return (
      <Detail
        entry={selected}
        onBack={() => {
          setSelected(null)
        }}
      />
    )
  }
  const needle = query.trim().toLowerCase()
  const visible = ALL.filter((entry) =>
    `${entry.name} ${entry.license}`.toLowerCase().includes(needle)
  )
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={searchId} className="sr-only">
        {t('settings.licenses.search')}
      </label>
      <input
        id={searchId}
        type="search"
        value={query}
        placeholder={t('settings.licenses.search')}
        onChange={(event) => {
          setQuery(event.target.value)
        }}
        className="h-10 rounded-lg border border-line bg-surface px-3 text-sm"
      />
      <p className="text-xs text-muted">{t('settings.licenses.count', { count: ALL.length })}</p>
      <ul className="flex flex-col rounded-xl border border-line bg-surface">
        {visible.map((entry) => (
          <li key={`${entry.name}@${entry.version}`} className="border-b border-line last:border-0">
            <button
              type="button"
              onClick={() => {
                setSelected(entry)
              }}
              className="flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-surface-2"
            >
              <span className="font-medium">{entry.name}</span>{' '}
              <span className="text-muted">{entry.version}</span>{' '}
              <span className="ml-auto text-xs text-muted">{entry.license}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
