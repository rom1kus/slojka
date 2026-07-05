import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from './i18n'
import './styles.css'

// Асинхронные ошибки (в т.ч. из обработчиков кнопок) не должны глотаться.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled rejection]', e.reason)
})

async function bootstrap(): Promise<void> {
  const lang = await window.slojka.getLanguage()
  await initI18n(lang)

  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

void bootstrap()
