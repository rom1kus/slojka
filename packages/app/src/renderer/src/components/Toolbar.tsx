import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditorStore, type Tool } from '../stores/editorStore'
import { useAiStore } from '../stores/aiStore'
import { samReset } from '../tools/samTool'
import { BrushPopup } from './BrushPopup'
import {
  IconBrush,
  IconChevron,
  IconCrop,
  IconEraser,
  IconGear,
  IconHand,
  IconLasso,
  IconMarqueeEllipse,
  IconMarqueeRect,
  IconMove,
  IconSam,
  IconText,
  IconWand,
} from './icons'

type SelectTool =
  | 'select-rect'
  | 'select-ellipse'
  | 'lasso'
  | 'wand'
  | 'sam'
  | 'select-brush-add'
  | 'select-brush-sub'

const SELECT_TOOLS: { id: SelectTool; icon: React.JSX.Element; key: string; shortcut: string }[] = [
  { id: 'select-rect', icon: <IconMarqueeRect />, key: 'tools.selectRect', shortcut: 'M' },
  { id: 'select-ellipse', icon: <IconMarqueeEllipse />, key: 'tools.selectEllipse', shortcut: 'Shift+M' },
  { id: 'lasso', icon: <IconLasso />, key: 'tools.lasso', shortcut: 'L' },
  { id: 'wand', icon: <IconWand />, key: 'tools.wand', shortcut: 'W' },
  { id: 'sam', icon: <IconSam />, key: 'tools.sam', shortcut: 'A' },
  { id: 'select-brush-add', icon: <IconBrush />, key: 'tools.selectBrushAdd', shortcut: '' },
  { id: 'select-brush-sub', icon: <IconEraser />, key: 'tools.selectBrushSub', shortcut: '' },
]

export function Toolbar(): React.JSX.Element {
  const { t } = useTranslation()
  const tool = useEditorStore((s) => s.tool)
  const setTool = useEditorStore((s) => s.setTool)
  const samLoaded = useAiStore((s) => s.state === 'ready' && (s.sam?.loaded ?? false))
  const setSettingsOpen = useAiStore((s) => s.setSettingsOpen)

  const [selectFlyout, setSelectFlyout] = useState(false)
  // Пикер кистей: для кисти и для ластика (у ластика те же пресеты).
  const [popupFor, setPopupFor] = useState<'brush' | 'eraser' | null>(null)
  // Последний использованный подтип выделения — его показывает кнопка группы.
  const [lastSelect, setLastSelect] = useState<SelectTool>('select-rect')
  const rootRef = useRef<HTMLDivElement>(null)

  // Закрытие: клик/тап где угодно вне тулбара (включая холст).
  useEffect(() => {
    const close = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setSelectFlyout(false)
        setPopupFor(null)
      }
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [])

  // Смена инструмента закрывает пикер, если он больше не соответствует.
  useEffect(() => {
    if (popupFor && tool !== popupFor) setPopupFor(null)
    if (selectFlyout && !(SELECT_TOOLS as { id: string }[]).some((s) => s.id === tool)) {
      setSelectFlyout(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])

  const isSelectTool = (SELECT_TOOLS as { id: string }[]).some((s) => s.id === tool)
  const activeSelect = SELECT_TOOLS.find((s) => s.id === tool) ?? SELECT_TOOLS.find((s) => s.id === lastSelect)!

  const pick = (id: Tool): void => {
    if (tool === 'sam' && id !== 'sam') samReset()
    setTool(id)
  }

  return (
    <aside className="toolbar" ref={rootRef}>
      {/* Перемещение/трансформация */}
      <button
        className={`tool-btn ${tool === 'move' ? 'active' : ''}`}
        title={`${t('tools.move')} (V)`}
        onClick={() => pick('move')}
      >
        <IconMove />
      </button>

      {/* Выделение: одна кнопка, подтипы во флайауте (как в Photoshop) */}
      <div className="tool-group">
        <button
          className={`tool-btn ${isSelectTool ? 'active' : ''}`}
          title={`${t(activeSelect.key)} — ${t('tools.groupHint')}`}
          onClick={() => {
            if (isSelectTool) setSelectFlyout(!selectFlyout)
            else pick(activeSelect.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelectFlyout(!selectFlyout)
          }}
        >
          {activeSelect.icon}
          <span className="tool-corner">
            <IconChevron />
          </span>
        </button>
        {selectFlyout && (
          <div className="tool-flyout">
            {SELECT_TOOLS.map((s) => {
              const disabled = s.id === 'sam' && !samLoaded
              return (
                <button
                  key={s.id}
                  className={`flyout-item ${tool === s.id ? 'active' : ''}`}
                  disabled={disabled}
                  title={disabled ? t('tools.samDisabledHint') : undefined}
                  onClick={() => {
                    setLastSelect(s.id)
                    pick(s.id)
                    setSelectFlyout(false)
                  }}
                >
                  {s.icon}
                  <span>{t(s.key)}</span>
                  <span className="menu-accel">{s.shortcut}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Кисть: клик открывает пикер с превью мазков (как в Photoshop) */}
      <div className="tool-group">
        <button
          className={`tool-btn ${tool === 'brush' ? 'active' : ''}`}
          title={`${t('tools.brush')} (B)`}
          onClick={() => {
            if (tool === 'brush') setPopupFor(popupFor === 'brush' ? null : 'brush')
            else {
              pick('brush')
              setPopupFor('brush')
            }
          }}
        >
          <IconBrush />
          <span className="tool-corner">
            <IconChevron />
          </span>
        </button>
        {popupFor === 'brush' && <BrushPopup onClose={() => setPopupFor(null)} />}
      </div>

      {/* Ластик: тот же пикер пресетов */}
      <div className="tool-group">
        <button
          className={`tool-btn ${tool === 'eraser' ? 'active' : ''}`}
          title={`${t('tools.eraser')} (E)`}
          onClick={() => {
            if (tool === 'eraser') setPopupFor(popupFor === 'eraser' ? null : 'eraser')
            else {
              pick('eraser')
              setPopupFor('eraser')
            }
          }}
        >
          <IconEraser />
          <span className="tool-corner">
            <IconChevron />
          </span>
        </button>
        {popupFor === 'eraser' && <BrushPopup forEraser onClose={() => setPopupFor(null)} />}
      </div>

      <button
        className={`tool-btn ${tool === 'text' ? 'active' : ''}`}
        title={`${t('tools.text')} (T)`}
        onClick={() => pick('text')}
      >
        <IconText />
      </button>

      <button
        className={`tool-btn ${tool === 'crop' ? 'active' : ''}`}
        title={`${t('tools.crop')} (C)`}
        onClick={() => pick('crop')}
      >
        <IconCrop />
      </button>

      <button
        className={`tool-btn ${tool === 'pan' ? 'active' : ''}`}
        title={`${t('tools.pan')} (H)`}
        onClick={() => pick('pan')}
      >
        <IconHand />
      </button>

      <div className="toolbar-spacer" />
      <button className="tool-btn" title={t('settingsDlg.title')} onClick={() => setSettingsOpen(true)}>
        <IconGear />
      </button>
    </aside>
  )
}
