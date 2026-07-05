import { useTranslation } from 'react-i18next'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

/**
 * Панель истории: undo-стек (кликабельно — откат к состоянию ПОСЛЕ записи),
 * затем redo-стек (полупрозрачно — клик повторяет).
 */
export function HistoryPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { undo, redo } = useEditorStore((s) => s.historyLabels)
  const hasDoc = useEditorStore((s) => s.docJson !== null)
  if (!hasDoc || (undo.length === 0 && redo.length === 0)) return null

  return (
    <>
      <div className="panel-header">{t('panels.history')}</div>
      <div className="history-list">
        {undo.map((label, i) => (
          <div
            key={`u${i}`}
            className={`history-row ${i === undo.length - 1 ? 'current' : ''}`}
            onClick={() => editor.jumpHistory(undo.length - 1 - i)}
          >
            {t(label)}
          </div>
        ))}
        {redo.map((label, i) => (
          <div
            key={`r${i}`}
            className="history-row redo"
            onClick={() => editor.jumpHistory(-(i + 1))}
          >
            {t(label)}
          </div>
        ))}
      </div>
    </>
  )
}
