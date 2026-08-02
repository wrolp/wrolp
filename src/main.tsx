import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './editor/monacoSetup'
import './styles/index.scss'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
)
