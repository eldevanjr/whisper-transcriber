import { Banners } from './components/Banners'
import { BootSplash } from './components/BootSplash'
import { Toasts } from './components/Toasts'
import { useBootstrap } from './hooks/useBootstrap'
import { useAppStore } from './providers'
import { LiveScreen } from './screens/live/LiveScreen'
import { MainScreen } from './screens/main/MainScreen'
import { Onboarding } from './screens/onboarding/Onboarding'
import { SettingsScreen } from './screens/settings/SettingsScreen'

function Screen() {
  const onboarding = useAppStore((s) => s.onboarding)
  const view = useAppStore((s) => s.view)
  if (onboarding) return <Onboarding />
  if (view === 'live') return <LiveScreen />
  return view === 'settings' ? <SettingsScreen /> : <MainScreen />
}

export function App() {
  const ready = useBootstrap()
  if (!ready) return <BootSplash />
  return (
    <div className="flex h-full flex-col">
      <Banners />
      <div className="min-h-0 flex-1">
        <Screen />
      </div>
      <Toasts />
    </div>
  )
}
