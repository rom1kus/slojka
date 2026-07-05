import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CANVAS_LIMITS } from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

/**
 * Диалог «Размер холста»: новые габариты + якорь 3×3 — где остаётся
 * существующее содержимое (как в Photoshop Canvas Size).
 */
export function CanvasSizeDialog(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = useEditorStore((s) => s.canvasSizeOpen)
  const setOpen = useEditorStore((s) => s.setCanvasSizeOpen)
  const docJson = useEditorStore((s) => s.docJson)
  const [w, setW] = useState(0)
  const [h, setH] = useState(0)
  /** Колонка/строка якоря: 0, 0.5, 1. */
  const [ax, setAx] = useState(0.5)
  const [ay, setAy] = useState(0.5)

  useEffect(() => {
    if (open && docJson) {
      setW(docJson.width)
      setH(docJson.height)
      setAx(0.5)
      setAy(0.5)
    }
  }, [open, docJson])

  if (!open || !docJson) return null

  const clampSize = (v: number): number =>
    Math.max(CANVAS_LIMITS.min, Math.min(CANVAS_LIMITS.max, Math.round(v) || CANVAS_LIMITS.min))

  const apply = (): void => {
    const nw = clampSize(w)
    const nh = clampSize(h)
    const dx = Math.round((nw - docJson.width) * ax)
    const dy = Math.round((nh - docJson.height) * ay)
    editor.resizeCanvas(nw, nh, dx, dy)
    setOpen(false)
  }

  return (
    <div className="dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('canvasSize.title')}</h2>
        <p className="opt-hint">
          {t('canvasSize.current')}: {docJson.width} × {docJson.height} px
        </p>
        <label className="dialog-row">
          <span>{t('newDoc.width')}</span>
          <input
            type="number"
            min={CANVAS_LIMITS.min}
            max={CANVAS_LIMITS.max}
            autoFocus
            value={w}
            onChange={(e) => setW(Number(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          px
        </label>
        <label className="dialog-row">
          <span>{t('newDoc.height')}</span>
          <input
            type="number"
            min={CANVAS_LIMITS.min}
            max={CANVAS_LIMITS.max}
            value={h}
            onChange={(e) => setH(Number(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          px
        </label>
        <div className="dialog-row">
          <span>{t('canvasSize.anchor')}</span>
          <div className="anchor-grid" title={t('canvasSize.anchorHint')}>
            {[0, 0.5, 1].map((row) =>
              [0, 0.5, 1].map((col) => (
                <button
                  key={`${row}-${col}`}
                  className={`anchor-cell ${ax === col && ay === row ? 'active' : ''}`}
                  onClick={() => {
                    setAx(col)
                    setAy(row)
                  }}
                >
                  {ax === col && ay === row ? '◉' : '·'}
                </button>
              )),
            )}
          </div>
        </div>
        {(clampSize(w) < docJson.width || clampSize(h) < docJson.height) && (
          <p className="opt-hint">{t('canvasSize.cropWarning')}</p>
        )}
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
