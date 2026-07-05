import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BLEND_MODES, type BlendMode } from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { TextPanel } from './TextPanel'
import { HistoryPanel } from './HistoryPanel'
import { StylesDialog } from './StylesDialog'
import { AiPanel } from './AiPanel'

interface CtxMenuState {
  x: number
  y: number
  /** null = ПКМ по пустой области панели. */
  layerId: string | null
}

export function LayersPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const docJson = useEditorStore((s) => s.docJson)
  const maskEditLayerId = useEditorStore((s) => s.maskEditLayerId)
  const layerThumbs = useEditorStore((s) => s.layerThumbs)
  const selectedIds = useEditorStore((s) => s.selectedLayerIds)
  const setSelectedIds = useEditorStore((s) => s.setSelectedLayerIds)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [stylesFor, setStylesFor] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  // Drag-n-drop порядка слоёв (хуки ОБЯЗАНЫ быть до раннего return —
  // иначе React #310 и чёрный экран при открытии документа).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropMark, setDropMark] = useState<{ id: string; above: boolean } | null>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const close = (): void => setCtxMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [ctxMenu])

  if (!docJson) {
    return (
      <aside className="panels">
        <AiPanel />
        <div className="panel-header">{t('panels.layers')}</div>
        <div className="panel-body">—</div>
      </aside>
    )
  }

  const active = docJson.layers.find((l) => l.id === docJson.activeLayerId)
  const activeIndex = docJson.layers.findIndex((l) => l.id === docJson.activeLayerId)
  // В UI сверху — верхний слой.
  const displayLayers = [...docJson.layers].reverse()
  const multi = selectedIds.length > 1

  const handleDrop = (): void => {
    const doc = useEditorStore.getState().docJson
    if (!doc || !dragId || !dropMark || dragId === dropMark.id) {
      setDragId(null)
      setDropMark(null)
      return
    }
    const from = doc.layers.findIndex((l) => l.id === dragId)
    const refIndex = doc.layers.findIndex((l) => l.id === dropMark.id)
    if (from < 0 || refIndex < 0) return
    // «Выше» в UI = дальше по массиву документа (layers[0] — низ).
    let target = dropMark.above ? refIndex + 1 : refIndex
    if (from < target) target-- // удаление исходного сдвигает индексы
    if (target !== from) editor.moveLayer(dragId, target)
    setDragId(null)
    setDropMark(null)
  }

  const clickLayer = (e: React.MouseEvent, id: string): void => {
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+клик — мультивыбор (как в Photoshop).
      const next = selectedIds.includes(id)
        ? selectedIds.filter((s) => s !== id)
        : [...selectedIds, id]
      setSelectedIds(next.length ? next : [id])
      editor.setActiveLayer(id)
    } else {
      setSelectedIds([id])
      editor.setActiveLayer(id)
    }
  }

  const deleteSelected = (): void => {
    const ids = multi ? selectedIds : ctxMenu?.layerId ? [ctxMenu.layerId] : []
    for (const id of ids) {
      if (useEditorStore.getState().docJson!.layers.length > 1) editor.deleteLayer(id)
    }
    setSelectedIds([])
  }

  const mergeSelected = (): void => {
    if (selectedIds.length >= 2) {
      editor.mergeLayers(selectedIds)
      setSelectedIds([])
    }
  }

  return (
    <aside className="panels">
      <AiPanel />
      <TextPanel />
      <div className="panel-header">{t('panels.layers')}</div>

      {active && (
        <div className="layer-controls">
          <select
            value={active.blendMode}
            title={t('layers.blendMode')}
            onChange={(e) => editor.setLayerBlendMode(active.id, e.target.value as BlendMode)}
          >
            {BLEND_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`blend.${m}`)}
              </option>
            ))}
          </select>
          <label className="opt-row">
            <span className="opt-label">{t('layers.opacity')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={active.opacity}
              onChange={(e) => editor.setLayerOpacity(active.id, Number(e.target.value), false)}
              onPointerUp={(e) =>
                editor.setLayerOpacity(active.id, Number((e.target as HTMLInputElement).value), true)
              }
            />
            <span className="opt-value">{Math.round(active.opacity * 100)}%</span>
          </label>
        </div>
      )}

      <div
        className="layer-list"
        onContextMenu={(e) => {
          // ПКМ по пустой области (не по строке слоя).
          if (e.target === e.currentTarget) {
            e.preventDefault()
            setCtxMenu({ x: e.clientX, y: e.clientY, layerId: null })
          }
        }}
      >
        {displayLayers.map((layer) => (
          <div
            key={layer.id}
            className={`layer-row ${layer.id === docJson.activeLayerId ? 'active' : ''} ${
              selectedIds.includes(layer.id) && multi ? 'multi-selected' : ''
            } ${layer.clipped ? 'clipped' : ''} ${
              dropMark?.id === layer.id ? (dropMark.above ? 'drop-above' : 'drop-below') : ''
            } ${dragId === layer.id ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragId(layer.id)
              e.dataTransfer.effectAllowed = 'copyMove'
              // Для переноса слоя на вкладку другого документа.
              e.dataTransfer.setData('slojka/layer-id', layer.id)
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === layer.id) return
              e.preventDefault()
              const rect = e.currentTarget.getBoundingClientRect()
              const above = e.clientY < rect.top + rect.height / 2
              setDropMark((m) =>
                m?.id === layer.id && m.above === above ? m : { id: layer.id, above },
              )
            }}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop()
            }}
            onDragEnd={() => {
              setDragId(null)
              setDropMark(null)
            }}
            onClick={(e) => clickLayer(e, layer.id)}
            onDoubleClick={() => setStylesFor(layer.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (!selectedIds.includes(layer.id)) {
                setSelectedIds([layer.id])
                editor.setActiveLayer(layer.id)
              }
              setCtxMenu({ x: e.clientX, y: e.clientY, layerId: layer.id })
            }}
          >
            <input
              type="checkbox"
              className="layer-vis"
              title={t('layers.visible')}
              checked={layer.visible}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => editor.setLayerVisible(layer.id, e.target.checked)}
            />
            <span
              className="layer-thumb"
              title={t('layers.thumbHint')}
              onClick={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  // Ctrl+клик по миниатюре — выделение по альфе (как в PS).
                  e.stopPropagation()
                  editor.selectFromLayerAlpha(layer.id)
                }
              }}
            >
              {layerThumbs[layer.id] && <img src={layerThumbs[layer.id]} alt="" draggable={false} />}
            </span>
            {layer.kind === 'text' && <span className="layer-badge">Т</span>}
            {layer.kind === 'raster' && layer.smart && (
              <span className="layer-badge smart" title={t('layers.smartBadge')}>
                S
              </span>
            )}
            {layer.clipped && (
              <span className="layer-badge" title={t('layers.clipped')}>
                ⤵
              </span>
            )}
            {renamingId === layer.id ? (
              <input
                className="layer-rename"
                autoFocus
                defaultValue={layer.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  if (e.target.value.trim()) editor.renameLayer(layer.id, e.target.value.trim())
                  setRenamingId(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenamingId(null)
                }}
              />
            ) : (
              <span
                className="layer-name"
                onDoubleClick={(e) => {
                  // Двойной клик по имени — переименование; по остальной строке — стили.
                  e.stopPropagation()
                  setRenamingId(layer.id)
                }}
              >
                {layer.name}
              </span>
            )}
            {layer.hasMask && (
              <button
                className={`mask-chip ${maskEditLayerId === layer.id ? 'active' : ''}`}
                title={
                  maskEditLayerId === layer.id ? t('layers.maskEditingOn') : t('layers.editMask')
                }
                onClick={(e) => {
                  e.stopPropagation()
                  editor.setActiveLayer(layer.id)
                  editor.setMaskEditing(maskEditLayerId === layer.id ? null : layer.id)
                }}
              >
                ◧
              </button>
            )}
          </div>
        ))}
        <div
          className="layer-list-empty"
          onContextMenu={(e) => {
            e.preventDefault()
            setCtxMenu({ x: e.clientX, y: e.clientY, layerId: null })
          }}
        />
      </div>

      <div className="layer-actions">
        <button
          title={t('layers.add')}
          onClick={() => editor.addLayer(`${t('layers.defaultName')} ${docJson.layers.length + 1}`)}
        >
          +
        </button>
        <button
          title={t('layers.delete')}
          disabled={docJson.layers.length <= 1}
          onClick={() => active && editor.deleteLayer(active.id)}
        >
          −
        </button>
        <button
          title={t('layers.moveUp')}
          disabled={!active || activeIndex >= docJson.layers.length - 1}
          onClick={() => active && editor.moveLayer(active.id, activeIndex + 1)}
        >
          ↑
        </button>
        <button
          title={t('layers.moveDown')}
          disabled={!active || activeIndex <= 0}
          onClick={() => active && editor.moveLayer(active.id, activeIndex - 1)}
        >
          ↓
        </button>
        <button
          title={active?.hasMask ? t('layers.removeMask') : t('layers.addMask')}
          disabled={!active}
          onClick={() => {
            if (!active) return
            if (active.hasMask) editor.removeLayerMask(active.id)
            else editor.addLayerMask(active.id)
          }}
        >
          ◧
        </button>
        <button
          title={t('layers.clipped')}
          disabled={!active || activeIndex === 0}
          className={active?.clipped ? 'toggled' : ''}
          onClick={() => active && editor.setLayerClipped(active.id, !active.clipped)}
        >
          ⤵
        </button>
        <button
          title={t('layers.styles')}
          disabled={!active}
          className={active?.styles ? 'toggled' : ''}
          onClick={() => active && setStylesFor(active.id)}
        >
          fx
        </button>
      </div>

      <HistoryPanel />
      {stylesFor && <StylesDialog layerId={stylesFor} onClose={() => setStylesFor(null)} />}

      {ctxMenu && (
        <div
          className="context-menu"
          ref={(el) => {
            // Прижимаем меню к краям окна, чтобы не уходило за экран.
            if (!el) return
            const r = el.getBoundingClientRect()
            const left = Math.max(4, Math.min(ctxMenu.x, window.innerWidth - r.width - 4))
            const top = Math.max(4, Math.min(ctxMenu.y, window.innerHeight - r.height - 4))
            el.style.left = `${left}px`
            el.style.top = `${top}px`
          }}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="menu-item"
            onClick={() => {
              editor.addLayer(`${t('layers.defaultName')} ${docJson.layers.length + 1}`)
              setCtxMenu(null)
            }}
          >
            <span>{t('layers.ctxNew')}</span>
          </button>
          {ctxMenu.layerId && (
            <button
              className="menu-item"
              onClick={() => {
                editor.duplicateLayer(ctxMenu.layerId!)
                setCtxMenu(null)
              }}
            >
              <span>{t('layers.ctxDuplicate')}</span>
              <span className="menu-accel">Ctrl+J</span>
            </button>
          )}
          {multi && (
            <button
              className="menu-item"
              onClick={() => {
                mergeSelected()
                setCtxMenu(null)
              }}
            >
              <span>{t('layers.ctxMergeSelected', { count: selectedIds.length })}</span>
              <span className="menu-accel">Ctrl+E</span>
            </button>
          )}
          <button
            className="menu-item"
            disabled={docJson.layers.filter((l) => l.visible).length < 2}
            onClick={() => {
              editor.mergeVisible()
              setCtxMenu(null)
            }}
          >
            <span>{t('layers.ctxMergeVisible')}</span>
          </button>
          {(ctxMenu.layerId || multi) && (
            <button
              className="menu-item"
              disabled={docJson.layers.length <= 1}
              onClick={() => {
                deleteSelected()
                setCtxMenu(null)
              }}
            >
              <span>{multi ? t('layers.ctxDeleteMany', { count: selectedIds.length }) : t('layers.ctxDelete')}</span>
            </button>
          )}
          {ctxMenu.layerId && !multi && (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  setRenamingId(ctxMenu.layerId)
                  setCtxMenu(null)
                }}
              >
                <span>{t('layers.ctxRename')}</span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setStylesFor(ctxMenu.layerId)
                  setCtxMenu(null)
                }}
              >
                <span>{t('layers.ctxStyles')}</span>
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
