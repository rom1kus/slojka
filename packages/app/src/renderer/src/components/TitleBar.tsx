import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface MenuItemDef {
  id: string
  labelKey: string
  accel?: string
  separatorAfter?: boolean
}

interface MenuDef {
  labelKey: string
  items: MenuItemDef[]
}

/** Те же action-id, что и в нативном меню main-процесса (оно скрыто, но держит хоткеи). */
const MENUS: MenuDef[] = [
  {
    labelKey: 'menu.file',
    items: [
      { id: 'file.new', labelKey: 'menu.new', accel: 'Ctrl+N' },
      { id: 'file.open', labelKey: 'menu.open', accel: 'Ctrl+O' },
      { id: 'file.import', labelKey: 'menu.import', separatorAfter: true },
      { id: 'file.save', labelKey: 'menu.save', accel: 'Ctrl+S' },
      { id: 'file.saveAs', labelKey: 'menu.saveAs', accel: 'Ctrl+Shift+S' },
      { id: 'file.export', labelKey: 'menu.export', accel: 'Ctrl+Alt+S' },
    ],
  },
  {
    labelKey: 'menu.edit',
    items: [
      { id: 'edit.undo', labelKey: 'menu.undo', accel: 'Ctrl+Z' },
      { id: 'edit.redo', labelKey: 'menu.redo', accel: 'Ctrl+Shift+Z', separatorAfter: true },
      { id: 'edit.clear', labelKey: 'menu.clear', accel: 'Del' },
    ],
  },
  {
    labelKey: 'menu.image',
    items: [{ id: 'image.canvasSize', labelKey: 'menu.canvasSize' }],
  },
  {
    labelKey: 'menu.selection',
    items: [
      { id: 'select.all', labelKey: 'menu.selectAll', accel: 'Ctrl+A' },
      { id: 'select.deselect', labelKey: 'menu.deselect', accel: 'Ctrl+D' },
      { id: 'select.invert', labelKey: 'menu.invertSelection', accel: 'Ctrl+Shift+I', separatorAfter: true },
      { id: 'select.feather', labelKey: 'menu.feather', accel: 'Shift+F6' },
    ],
  },
  {
    labelKey: 'menu.view',
    items: [
      { id: 'view.zoomIn', labelKey: 'menu.zoomIn', accel: 'Ctrl+=' },
      { id: 'view.zoomOut', labelKey: 'menu.zoomOut', accel: 'Ctrl+-' },
      { id: 'view.zoomFit', labelKey: 'menu.zoomFit', accel: 'Ctrl+0' },
      { id: 'view.zoomActual', labelKey: 'menu.zoomActual', accel: 'Ctrl+1' },
    ],
  },
]

export function TitleBar(props: { onAction: (id: string) => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Клик мимо — закрыть выпадашку.
  useEffect(() => {
    if (openMenu === null) return
    const close = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [openMenu])

  return (
    <header className="titlebar" ref={barRef}>
      <span className="brand-logo">Slojka</span>

      <div className="titlebar-drag" onDoubleClick={() => window.slojka.windowMaximize()} />

      <nav className="titlebar-menus">
        {MENUS.map((menu, i) => (
          <div key={menu.labelKey} className="menu-root">
            <button
              className={`menu-btn ${openMenu === i ? 'open' : ''}`}
              onClick={() => setOpenMenu(openMenu === i ? null : i)}
              onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
            >
              {t(menu.labelKey)}
            </button>
            {openMenu === i && (
              <div className="menu-dropdown">
                {menu.items.map((item) => (
                  <div key={item.id}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setOpenMenu(null)
                        props.onAction(item.id)
                      }}
                    >
                      <span>{t(item.labelKey)}</span>
                      {item.accel && <span className="menu-accel">{item.accel}</span>}
                    </button>
                    {item.separatorAfter && <div className="menu-sep" />}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      <div className="window-controls">
        <button title="—" onClick={() => window.slojka.windowMinimize()}>
          <svg viewBox="0 0 10 10" width="10" height="10">
            <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button title="□" onClick={() => window.slojka.windowMaximize()}>
          <svg viewBox="0 0 10 10" width="10" height="10">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        <button className="close" title="✕" onClick={() => window.slojka.windowClose()}>
          <svg viewBox="0 0 10 10" width="10" height="10">
            <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </header>
  )
}
