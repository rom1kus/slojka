import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CANVAS_LIMITS } from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

export function NewDocDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useEditorStore((s) => s.newDocOpen)
  const setOpen = useEditorStore((s) => s.setNewDocOpen)
  const [width, setWidth] = useState<number>(CANVAS_LIMITS.defaultWidth)
  const [height, setHeight] = useState<number>(CANVAS_LIMITS.defaultHeight)
  const [background, setBackground] = useState<'white' | 'transparent'>('white')

  if (!open) return null

  const clamp = (v: number): number =>
    Math.max(CANVAS_LIMITS.min, Math.min(CANVAS_LIMITS.max, Math.round(v) || CANVAS_LIMITS.min))

  const create = (): void => {
    void (async () => {
      const { snapshotCurrent, createTab } = await import('../io/tabs')
      await snapshotCurrent()
      createTab('Без имени')
      editor.newDocument(clamp(width), clamp(height), background)
      setOpen(false)
    })()
  }

  const large = clamp(width) > CANVAS_LIMITS.warn || clamp(height) > CANVAS_LIMITS.warn

  return (
    <div className="dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('newDoc.title')}</h2>
        <label className="dialog-row">
          <span>{t('newDoc.width')}</span>
          <input
            type="number"
            min={CANVAS_LIMITS.min}
            max={CANVAS_LIMITS.max}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
          px
        </label>
        <label className="dialog-row">
          <span>{t('newDoc.height')}</span>
          <input
            type="number"
            min={CANVAS_LIMITS.min}
            max={CANVAS_LIMITS.max}
            value={height}
            onChange={(e) => setHeight(Number(e.target.value))}
          />
          px
        </label>
        <label className="dialog-row">
          <span>{t('newDoc.background')}</span>
          <select
            value={background}
            onChange={(e) => setBackground(e.target.value as 'white' | 'transparent')}
          >
            <option value="white">{t('newDoc.bgWhite')}</option>
            <option value="transparent">{t('newDoc.bgTransparent')}</option>
          </select>
        </label>
        {large && <p className="dialog-warning">{t('newDoc.largeWarning')}</p>}
        <div className="dialog-buttons">
          <button className="primary" onClick={create}>
            {t('newDoc.create')}
          </button>
          <button onClick={() => setOpen(false)}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
