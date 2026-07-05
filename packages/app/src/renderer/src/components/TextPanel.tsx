import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  setStyleRange,
  type TextAlign,
  type TextLayerJson,
  type TextStylePatch,
  type TextStyleRange,
} from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { FontSelect } from './FontSelect'

let fontsCache: string[] | null = null

/** Плавающая панель редактирования активного текстового слоя. */
export function TextPanel(): React.JSX.Element | null {
  const { t } = useTranslation()
  const docJson = useEditorStore((s) => s.docJson)
  const [fonts, setFonts] = useState<string[]>(fontsCache ?? [])
  /** Шрифт до начала hover-превью (для отката/истории). */
  const previewBase = useRef<string | null>(null)
  /** styleRanges до hover-превью шрифта фрагмента. */
  const fragPreviewBase = useRef<TextStyleRange[] | null>(null)
  /** Последнее выделение в textarea (переживает уход фокуса на color input). */
  const [sel, setSel] = useState({ start: 0, end: 0 })

  useEffect(() => {
    if (!fontsCache) {
      void window.slojka.getFonts().then((list) => {
        fontsCache = list
        setFonts(list)
      })
    }
  }, [])

  const layer = docJson?.layers.find(
    (l): l is TextLayerJson => l.id === docJson.activeLayerId && l.kind === 'text',
  )
  if (!layer) return null

  const p = layer.text
  const set = (patch: Partial<typeof p>, commit = true): void =>
    editor.setTextParams(layer.id, patch, commit)

  const selStart = Math.min(sel.start, p.content.length)
  const selEnd = Math.min(sel.end, p.content.length)
  const hasSel = selStart < selEnd
  /** Эффективный стиль под началом выделения — стартовые значения контролов. */
  const fragRange = hasSel
    ? p.styleRanges?.find((r) => r.start <= selStart && r.end > selStart)
    : undefined
  const eff = {
    color: fragRange?.color ?? p.color,
    fontFamily: fragRange?.fontFamily ?? p.fontFamily,
    fontStyle: fragRange?.fontStyle ?? p.fontStyle,
    fontSize: fragRange?.fontSize ?? p.fontSize,
  }
  const applyFrag = (patch: TextStylePatch | null): void => {
    if (!hasSel) return
    const ranges = setStyleRange(p.styleRanges, selStart, selEnd, patch)
    editor.commitTextChange(layer.id, { styleRanges: p.styleRanges ?? [] }, { styleRanges: ranges })
  }
  const toggleFragStyle = (token: 'bold' | 'italic'): void => {
    const parts = new Set(eff.fontStyle.split(' ').filter((s) => s && s !== 'normal'))
    if (parts.has(token)) parts.delete(token)
    else parts.add(token)
    applyFrag({ fontStyle: parts.size ? [...parts].join(' ') : 'normal' })
  }

  const styleHas = (token: string): boolean => p.fontStyle.includes(token)
  const toggleStyle = (token: 'bold' | 'italic'): void => {
    const parts = new Set(p.fontStyle.split(' ').filter((s) => s && s !== 'normal'))
    if (parts.has(token)) parts.delete(token)
    else parts.add(token)
    set({ fontStyle: parts.size ? [...parts].join(' ') : 'normal' })
  }

  return (
    <div className="text-panel">
      <div className="panel-header">{t('text.title')}</div>
      <textarea
        className="text-content"
        rows={3}
        placeholder={t('text.placeholder')}
        value={p.content}
        onFocus={(e) => {
          e.currentTarget.dataset['start'] = p.content
        }}
        onSelect={(e) => {
          const el = e.currentTarget
          setSel({ start: el.selectionStart, end: el.selectionEnd })
        }}
        onChange={(e) => set({ content: e.target.value }, false)}
        onBlur={(e) => {
          const start = e.currentTarget.dataset['start'] ?? ''
          if (start !== e.target.value) {
            editor.commitTextChange(layer.id, { content: start }, { content: e.target.value })
          }
        }}
      />
      <label className="dialog-row">
        <span>{t('text.font')}</span>
        <FontSelect
          value={p.fontFamily}
          fonts={fonts}
          sampleText={p.content}
          onChange={(fontFamily) => {
            // Одна запись истории: от шрифта до превью к выбранному.
            const base = previewBase.current ?? p.fontFamily
            previewBase.current = null
            editor.commitTextChange(layer.id, { fontFamily: base }, { fontFamily })
          }}
          onPreview={(family) => {
            // Наведение — живое применение на холст без истории.
            if (family !== null) {
              previewBase.current ??= p.fontFamily
              set({ fontFamily: family }, false)
            } else if (previewBase.current) {
              set({ fontFamily: previewBase.current }, false)
              previewBase.current = null
            }
          }}
        />
      </label>
      <div className="dialog-row">
        <span>{t('text.size')}</span>
        <input
          type="number"
          min={4}
          max={800}
          value={p.fontSize}
          onChange={(e) => set({ fontSize: Number(e.target.value) || 12 })}
        />
        <input
          type="color"
          className="color-input"
          value={p.color}
          onChange={(e) => set({ color: e.target.value })}
        />
        <button
          className={`style-btn ${styleHas('bold') ? 'active' : ''}`}
          onClick={() => toggleStyle('bold')}
        >
          Ж
        </button>
        <button
          className={`style-btn italic ${styleHas('italic') ? 'active' : ''}`}
          onClick={() => toggleStyle('italic')}
        >
          К
        </button>
      </div>
      <div className="dialog-row" title={t('text.fragmentHint')}>
        <span>{t('text.fragment')}</span>
        {hasSel ? (
          <>
            <input
              type="number"
              min={4}
              max={800}
              value={eff.fontSize}
              onChange={(e) => applyFrag({ fontSize: Number(e.target.value) || 12 })}
            />
            <input
              type="color"
              className="color-input"
              value={eff.color}
              onChange={(e) => applyFrag({ color: e.target.value })}
            />
            <button
              className={`style-btn ${eff.fontStyle.includes('bold') ? 'active' : ''}`}
              onClick={() => toggleFragStyle('bold')}
            >
              Ж
            </button>
            <button
              className={`style-btn italic ${eff.fontStyle.includes('italic') ? 'active' : ''}`}
              onClick={() => toggleFragStyle('italic')}
            >
              К
            </button>
            <button className="style-btn" title={t('text.fragmentReset')} onClick={() => applyFrag(null)}>
              ✕
            </button>
          </>
        ) : p.styleRanges?.length ? (
          <button
            className="style-btn"
            title={t('text.fragmentResetAll')}
            onClick={() =>
              editor.commitTextChange(
                layer.id,
                { styleRanges: p.styleRanges ?? [] },
                { styleRanges: [] },
              )
            }
          >
            ✕
          </button>
        ) : (
          <span className="opt-hint">{t('text.fragmentHint')}</span>
        )}
      </div>
      {hasSel && (
        <label className="dialog-row">
          <span>{t('text.font')}</span>
          <FontSelect
            value={eff.fontFamily}
            fonts={fonts}
            sampleText={p.content.slice(selStart, selEnd)}
            onChange={(fontFamily) => {
              // Одна запись истории: от диапазонов до превью к выбранным.
              const base = fragPreviewBase.current ?? p.styleRanges ?? []
              fragPreviewBase.current = null
              editor.commitTextChange(
                layer.id,
                { styleRanges: base },
                { styleRanges: setStyleRange(base, selStart, selEnd, { fontFamily }) },
              )
            }}
            onPreview={(family) => {
              if (family !== null) {
                fragPreviewBase.current ??= p.styleRanges ?? []
                set(
                  {
                    styleRanges: setStyleRange(fragPreviewBase.current, selStart, selEnd, {
                      fontFamily: family,
                    }),
                  },
                  false,
                )
              } else if (fragPreviewBase.current) {
                set({ styleRanges: fragPreviewBase.current }, false)
                fragPreviewBase.current = null
              }
            }}
          />
        </label>
      )}
      <div className="dialog-row">
        <span>{t('text.rotation')}</span>
        <input
          type="number"
          step={1}
          min={-360}
          max={360}
          value={p.rotation ?? 0}
          onChange={(e) => set({ rotation: Number(e.target.value) || 0 })}
        />
        <input
          type="range"
          min={-180}
          max={180}
          value={p.rotation ?? 0}
          onChange={(e) => set({ rotation: Number(e.target.value) }, false)}
          onPointerUp={(e) => set({ rotation: Number((e.target as HTMLInputElement).value) })}
        />
      </div>
      <div className="dialog-row">
        <span>{t('text.letterSpacing')}</span>
        <input
          type="number"
          step={0.5}
          value={p.letterSpacing}
          onChange={(e) => set({ letterSpacing: Number(e.target.value) || 0 })}
        />
        <span>{t('text.lineHeight')}</span>
        <input
          type="number"
          step={0.1}
          min={0.5}
          max={4}
          value={p.lineHeight}
          onChange={(e) => set({ lineHeight: Number(e.target.value) || 1.2 })}
        />
      </div>
      <div className="dialog-row">
        <span>{t('text.align')}</span>
        {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
          <button
            key={a}
            className={`style-btn ${p.align === a ? 'active' : ''}`}
            onClick={() => set({ align: a })}
          >
            {a === 'left' ? '⯇' : a === 'center' ? '☰' : '⯈'}
          </button>
        ))}
      </div>
      <p className="opt-hint">{t('text.moveHint')}</p>
    </div>
  )
}
