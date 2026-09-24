import { X } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../providers'
import type { Notice } from '../store/app-store'
import { IconButton } from './Button'

const INFO_MS = 6000

function Toast({ notice }: { notice: Notice }) {
  const { t } = useTranslation()
  const dismiss = useAppStore((s) => s.dismissNotice)

  useEffect(() => {
    if (notice.kind !== 'info') return
    const timer = setTimeout(() => {
      dismiss(notice.id)
    }, INFO_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [dismiss, notice.id, notice.kind])

  const tone = notice.kind === 'error' ? 'border-danger/40 text-danger' : 'border-line text-fg'
  return (
    <li
      className={`flex items-start gap-3 rounded-xl border bg-surface p-3 text-sm shadow-lg ${tone}`}
    >
      <p className="flex-1">
        {t(notice.key, notice.values)}
        {notice.error && <span className="block text-xs text-muted">{notice.error.message}</span>}
      </p>
      <IconButton
        label={t('common.dismiss')}
        icon={X}
        onClick={() => {
          dismiss(notice.id)
        }}
      />
    </li>
  )
}

export function Toasts() {
  const notices = useAppStore((s) => s.notices)
  return (
    <ul
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 flex w-96 max-w-[calc(100%-2rem)] flex-col gap-2"
    >
      {notices.map((notice) => (
        <Toast key={notice.id} notice={notice} />
      ))}
    </ul>
  )
}
