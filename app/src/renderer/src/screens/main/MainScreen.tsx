import { useTranslation } from 'react-i18next'
import { useDropFiles } from '../../hooks/useDropFiles'
import { useEntryDetail } from '../../hooks/useEntryDetail'
import { PlayerProvider } from '../../hooks/usePlayer'
import { useQueueActions } from '../../hooks/useQueueActions'
import { useAppStore } from '../../providers'
import { ChatPanel } from './ChatPanel'
import { EmptyState } from './EmptyState'
import { Player } from './Player'
import { ResultPanel } from './ResultPanel'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

function Workspace() {
  const { t } = useTranslation()
  const meta = useAppStore((s) => (s.selectedId === null ? undefined : s.entries[s.selectedId]))
  const detail = useEntryDetail(meta)
  if (!meta) {
    return (
      <>
        <div className="flex min-h-0 flex-col">
          <EmptyState />
        </div>
        <aside className="border-l border-line bg-surface p-4 text-sm text-muted">
          {t('main.selectPrompt')}
        </aside>
      </>
    )
  }
  return (
    <>
      <div className="flex min-h-0 flex-col">
        {/* Chave com o status: o áudio só existe depois da extração, então ao concluir
            o player remonta e carrega a mídia de novo. */}
        <Player key={`${meta.id}:${meta.status}`} meta={meta} detail={detail} />
      </div>
      <aside className="min-h-0 border-l border-line bg-surface">
        {meta.status === 'done' ? (
          <ResultPanel key={meta.id} meta={meta} detail={detail} />
        ) : (
          <ChatPanel meta={meta} detail={detail} />
        )}
      </aside>
    </>
  )
}

export function MainScreen() {
  const { t } = useTranslation()
  const actions = useQueueActions()
  const dragging = useDropFiles((paths) => void actions.enqueue(paths))
  return (
    <PlayerProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <main className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_minmax(320px,420px)]">
          <Sidebar />
          <Workspace />
        </main>
      </div>
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center bg-accent-solid/20 backdrop-blur-sm">
          <p className="rounded-2xl bg-surface px-8 py-6 text-xl font-semibold text-accent shadow-xl">
            {t('main.drop')}
          </p>
        </div>
      )}
    </PlayerProvider>
  )
}
