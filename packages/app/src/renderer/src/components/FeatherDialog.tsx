import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

export function FeatherDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useEditorStore((s) => s.featherOpen)
  const setOpen = useEditorStore((s) => s.setFeatherOpen)
  const [radius, setRadius] = useState(8)

  if (!open) return null

  const apply = (): void => {
    editor.featherSelection(radius)
    setOpen(false)
  }

  return (
    <div className="dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('feather.title')}</h2>
        <label className="dialog-row">
          <span>{t('feather.radius')}</span>
          <input
            type="number"
            min={1}
            max={100}
            autoFocus
            value={radius}
            onChange={(e) => setRadius(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          px
        </label>
        <div className="dialog-buttons">
          <button className="primary" onClick={apply}>
            {t('common.ok')}
          </button>
          <button onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
