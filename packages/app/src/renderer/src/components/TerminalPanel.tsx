import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useEditorStore } from '../stores/editorStore'

/**
 * Встроенный терминал с Claude Code: запускается в директории текущего
 * проекта, .mcp.json уже сгенерирован — claude сразу видит инструменты
 * Слойки и может редактировать документ за пользователя.
 */
export function TerminalPanel(props: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let term: Terminal | null = null
    let sessionId: number | null = null
    let disposed = false

    void (async () => {
      const avail = await window.slojka.termAvailable()
      if (!avail.ok) {
        setError(t('terminal.unavailable', { error: avail.error ?? '' }))
        return
      }
      if (disposed || !hostRef.current) return

      term = new Terminal({
        fontSize: 13,
        theme: { background: '#1b1b1f', foreground: '#d8d8dc' },
        cursorBlink: true,
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      fit.fit()
      // Фокус сразу в терминал: иначе он остаётся на кнопке «AI-ассистент»
      // и Enter (например, подтверждение доступа claude) закрывает панель.
      term.focus()

      const { id } = await window.slojka.termStart({
        filePath: useEditorStore.getState().filePath,
        cols: term.cols,
        rows: term.rows,
      })
      sessionId = id

      term.onData((data) => window.slojka.termInput(id, data))
      window.slojka.onTermData((sid, data) => {
        if (sid === id) term?.write(data)
      })
      window.slojka.onTermExit((sid) => {
        if (sid === id) term?.write('\r\n[процесс завершён]\r\n')
      })

      const ro = new ResizeObserver(() => {
        fit.fit()
        if (sessionId !== null && term) window.slojka.termResize(sessionId, term.cols, term.rows)
      })
      ro.observe(hostRef.current)
    })()

    return () => {
      disposed = true
      if (sessionId !== null) window.slojka.termKill(sessionId)
      term?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span>{t('terminal.title')}</span>
        <span className="spacer" />
        <button className="style-btn" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {error ? (
        <div className="terminal-error">
          <p>{error}</p>
          <p className="opt-hint">{t('terminal.fallbackHint')}</p>
        </div>
      ) : (
        <div ref={hostRef} className="terminal-host" />
      )}
    </div>
  )
}
