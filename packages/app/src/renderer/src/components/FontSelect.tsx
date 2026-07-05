import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Выбор шрифта с живым превью: каждое имя отрисовано своим шрифтом
 * (как в Photoshop). С поиском.
 */
export function FontSelect(props: {
  value: string
  fonts: string[]
  onChange: (family: string) => void
  /** Живое применение при наведении (null = вернуть исходный). */
  onPreview?: (family: string | null) => void
  /** Текст для образцов (обычно — содержимое активного слоя). */
  sampleText?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false)
        props.onPreview?.(null) // закрыли без выбора — вернуть исходный шрифт
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const filtered = props.fonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
  const sample = (props.sampleText?.trim().slice(0, 24) || 'Аа Бб Abc 123').replace(/\n/g, ' ')

  return (
    <div className="font-select" ref={rootRef}>
      <button
        className="font-select-btn"
        style={{ fontFamily: props.value }}
        onClick={() => setOpen(!open)}
        title={props.value}
      >
        {props.value}
      </button>
      {open && (
        <div className="font-select-drop">
          <input
            autoFocus
            placeholder={t('text.fontSearch')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="font-select-list">
            {filtered.slice(0, 400).map((f) => (
              <button
                key={f}
                className={`font-option ${f === props.value ? 'active' : ''}`}
                onMouseEnter={() => props.onPreview?.(f)}
                onClick={() => {
                  props.onChange(f)
                  setOpen(false)
                }}
              >
                <span className="font-option-name">{f}</span>
                <span className="font-option-sample" style={{ fontFamily: `"${f}"` }}>
                  {sample}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
