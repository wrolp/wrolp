import ReactDOM from 'react-dom/client'
import App, { ErrorBoundary } from './App'
import { I18nProvider } from './i18n'
import './editor/monacoSetup'
import './styles/index.scss'
import { initTheme } from './lib/themeStore'

// Apply the persisted theme (and start following the OS setting) before the first
// render, so a light UI never flashes dark on startup.
initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </I18nProvider>,
)
