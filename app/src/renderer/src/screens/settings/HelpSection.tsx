import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildDiagnostic, buildIssueUrl } from '../../../../shared/diagnostics'
import { Button } from '../../components/Button'
import { useApi, useAppStore } from '../../providers'

const ARTICLES = ['quickStart', 'whichModel', 'gpu', 'unsigned', 'problems', 'privacy'] as const

/** Minúsculas e sem acentos, para a busca achar "memória" digitando "memoria". */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function HelpSection() {
  const { t } = useTranslation()
  const api = useApi()
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const searchId = useId()
  const [query, setQuery] = useState('')
  const needle = normalize(query.trim())
  const articles = ARTICLES.map((id) => ({
    id,
    title: t(`help.${id}.title`),
    body: t(`help.${id}.body`)
  })).filter((article) => normalize(`${article.title} ${article.body}`).includes(needle))

  const report = (): void => {
    const diagnostic = buildDiagnostic({
      error: { code: 'INTERNAL', message: 'Relato pela Ajuda' },
      appInfo,
      settings,
      userAgent: navigator.userAgent
    })
    void api.system.openExternal(buildIssueUrl('', diagnostic))
  }

  return (
    <div className="flex flex-col gap-5">
      <label htmlFor={searchId} className="sr-only">
        {t('settings.help.search')}
      </label>
      <input
        id={searchId}
        type="search"
        value={query}
        placeholder={t('settings.help.search')}
        onChange={(event) => {
          setQuery(event.target.value)
        }}
        className="h-10 rounded-lg border border-line bg-surface px-3 text-sm"
      />
      {articles.length === 0 && (
        <p className="text-sm text-muted">{t('settings.help.noResults')}</p>
      )}
      {articles.map((article) => (
        <article key={article.id} className="rounded-xl border border-line bg-surface p-5">
          <h2 className="mb-2 font-semibold">{article.title}</h2>
          {article.body.split('\n').map((paragraph) => (
            <p key={paragraph} className="mb-2 text-sm leading-relaxed text-muted last:mb-0">
              {paragraph}
            </p>
          ))}
        </article>
      ))}
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted">{t('settings.help.report')}</span>
        <Button size="sm" variant="secondary" onClick={report}>
          {t('errors.report')}
        </Button>
      </div>
    </div>
  )
}
