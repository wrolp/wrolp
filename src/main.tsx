import ReactDOM from 'react-dom/client'
import App, { ErrorBoundary } from './App'
import { I18nProvider } from './i18n'
import { TooltipProvider } from './components/Tooltip'
import { SelectOverlay } from './components/SelectOverlay'
import './editor/monacoSetup'
import './styles/index.scss'
import { initTheme } from './lib/themeStore'
import { FloatTerminal } from './FloatTerminal'
import { readFloatParams } from './lib/floatWindow'

// Apply the persisted theme (and start following the OS setting) before the first
// render, so a light UI never flashes dark on startup.
initTheme()

// A float window loads this same bundle with `?float=terminal&tab=<id>`; it runs
// one terminal instead of the whole app (see `src/FloatTerminal.tsx`). The query
// is read once: a window never switches what it shows.
const float = readFloatParams()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <ErrorBoundary>
      {float ? <FloatTerminal tabId={float.tabId} /> : <App />}
      <TooltipProvider />
      <SelectOverlay />
    </ErrorBoundary>
  </I18nProvider>,
)
