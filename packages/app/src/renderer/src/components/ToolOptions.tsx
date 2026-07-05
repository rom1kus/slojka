import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { importBrushFiles } from '../io/brushes'
import { samCommit, samCycleMask, samReset, useSamStore } from '../tools/samTool'
import { applyCrop, cancelCrop } from '../tools/cropTool'

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <label className="opt-row">
      <span className="opt-label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="opt-value">{props.format?.(props.value) ?? props.value}</span>
    </label>
  )
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

const SELECTION_TOOLS = ['select-rect', 'select-ellipse', 'lasso', 'wand'] as const

function BrushPresetPicker(): React.JSX.Element {
  const { t } = useTranslation()
  const presets = useEditorStore((s) => s.presets)
  const activePresetId = useEditorStore((s) => s.activePresetId)
  const applyPreset = useEditorStore((s) => s.applyPreset)
  const setPresets = useEditorStore((s) => s.setPresets)
  const setToast = useEditorStore((s) => s.setToast)

  const doImport = async (): Promise<void> => {
    const { added, skipped } = await importBrushFiles()
    if (added.length > 0) {
      setPresets([...useEditorStore.getState().presets, ...added])
    }
    setToast(t('brushes.importResult', { added: added.length, skipped }))
  }

  return (
    <label className="opt-row">
      <span className="opt-label">{t('brushes.preset')}</span>
      <select value={activePresetId} onChange={(e) => applyPreset(e.target.value)}>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className="style-btn wide" title={t('brushes.import')} onClick={() => void doImport()}>
        ⤓
      </button>
    </label>
  )
}

/** Ползунки живой настройки активного выделения (видны при муравьях). */
export function SelectionAdjust(): React.JSX.Element | null {
  const { t } = useTranslation()
  const hasSelection = useEditorStore((s) => s.hasSelection)
  const [adj, setAdj] = useState({ feather: 0, expand: 0 })
  const adjusting = useRef(false)

  if (!hasSelection) return null

  const startAdjust = (): void => {
    if (!adjusting.current && editor.beginSelectionAdjust()) adjusting.current = true
  }
  const liveAdjust = (patch: Partial<typeof adj>): void => {
    const next = { ...adj, ...patch }
    setAdj(next)
    if (adjusting.current) editor.previewSelectionAdjust(next.feather, next.expand)
  }
  const commitAdjust = (): void => {
    if (adjusting.current) {
      editor.commitSelectionAdjust(adj.feather, adj.expand)
      adjusting.current = false
      setAdj({ feather: 0, expand: 0 })
    }
  }

  return (
    <>
      <label className="opt-row" onPointerDown={startAdjust} onPointerUp={commitAdjust}>
        <span className="opt-label">{t('selection.featherSlider')}</span>
        <input
          type="range"
          min={0}
          max={60}
          value={adj.feather}
          onChange={(e) => liveAdjust({ feather: Number(e.target.value) })}
        />
        <span className="opt-value">{adj.feather}px</span>
      </label>
      <label className="opt-row" onPointerDown={startAdjust} onPointerUp={commitAdjust}>
        <span className="opt-label">{t('selection.expandSlider')}</span>
        <input
          type="range"
          min={-30}
          max={30}
          value={adj.expand}
          onChange={(e) => liveAdjust({ expand: Number(e.target.value) })}
        />
        <span className="opt-value">
          {adj.expand > 0 ? '+' : ''}
          {adj.expand}px
        </span>
      </label>
    </>
  )
}

function SelectionOptions(): React.JSX.Element {
  const { t } = useTranslation()
  const tool = useEditorStore((s) => s.tool)
  const op = useEditorStore((s) => s.selectionOp)
  const setOp = useEditorStore((s) => s.setSelectionOp)
  const tolerance = useEditorStore((s) => s.wandTolerance)
  const setTolerance = useEditorStore((s) => s.setWandTolerance)

  return (
    <div className="tool-options">
      <label className="opt-row">
        <span className="opt-label">{t('selection.op')}</span>
        <select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
          <option value="replace">{t('selection.replace')}</option>
          <option value="add">{t('selection.add')}</option>
          <option value="subtract">{t('selection.subtract')}</option>
          <option value="intersect">{t('selection.intersect')}</option>
        </select>
      </label>
      {tool === 'wand' && (
        <Slider
          label={t('selection.tolerance')}
          value={tolerance}
          min={0}
          max={255}
          onChange={setTolerance}
        />
      )}
      <SelectionAdjust />
      <span className="opt-hint">{t('selection.modsHint')}</span>
    </div>
  )
}

function SamOptions(): React.JSX.Element {
  const { t } = useTranslation()
  const masks = useSamStore((s) => s.masks)
  const active = useSamStore((s) => s.active)
  const busy = useSamStore((s) => s.busy)
  const error = useSamStore((s) => s.error)

  return (
    <div className="tool-options">
      <span className="opt-hint">{t('sam.hint')}</span>
      {busy && <span className="opt-hint">{t('sam.busy')}</span>}
      {error && <span className="dialog-warning">{error}</span>}
      <SelectionAdjust />
      {masks.length > 0 && (
        <>
          <button className="style-btn wide" onClick={samCycleMask}>
            {t('sam.variant')} {active + 1}/{masks.length} ({Math.round((masks[active]?.score ?? 0) * 100)}%)
          </button>
          <button className="style-btn wide" onClick={() => void samCommit('selection')}>
            {t('sam.toSelection')}
          </button>
          <button className="style-btn wide" onClick={() => void samCommit('layer-mask')}>
            {t('sam.toMask')}
          </button>
          <button className="style-btn wide" onClick={samReset}>
            {t('common.cancel')}
          </button>
        </>
      )}
    </div>
  )
}

/** Опции кадрирования: размер рамки, применить/отмена. */
function CropOptions(): React.JSX.Element {
  const { t } = useTranslation()
  const cropRect = useEditorStore((s) => s.cropRect)
  return (
    <div className="tool-options">
      {cropRect ? (
        <>
          <span className="opt-label">
            {cropRect.w} × {cropRect.h} px
          </span>
          <button className="style-btn wide primary" onClick={applyCrop}>
            {t('crop.apply')}
          </button>
          <button className="style-btn wide" onClick={cancelCrop}>
            {t('common.cancel')}
          </button>
          <span className="opt-hint">{t('crop.applyHint')}</span>
        </>
      ) : (
        <span className="opt-hint">{t('crop.hint')}</span>
      )}
    </div>
  )
}

export function ToolOptions(): React.JSX.Element | null {
  const { t } = useTranslation()
  const tool = useEditorStore((s) => s.tool)
  const brush = useEditorStore((s) => s.brush)
  const setBrush = useEditorStore((s) => s.setBrush)
  const color = useEditorStore((s) => s.color)
  const setColor = useEditorStore((s) => s.setColor)

  if (tool === 'pan' || tool === 'text') return null
  if (tool === 'crop') return <CropOptions />
  if (tool === 'sam') return <SamOptions />
  if ((SELECTION_TOOLS as readonly string[]).includes(tool)) return <SelectionOptions />

  return (
    <div className="tool-options">
      {tool === 'brush' && (
        <input
          className="color-input"
          type="color"
          value={color}
          title={t('toolOptions.color')}
          onChange={(e) => setColor(e.target.value)}
        />
      )}
      <BrushPresetPicker />
      <SelectionAdjust />
      <Slider
        label={t('toolOptions.size')}
        value={brush.size}
        min={1}
        max={500}
        onChange={(size) => setBrush({ size })}
      />
      <Slider
        label={t('toolOptions.hardness')}
        value={brush.hardness}
        min={0}
        max={1}
        step={0.01}
        format={pct}
        onChange={(hardness) => setBrush({ hardness })}
      />
      <Slider
        label={t('toolOptions.opacity')}
        value={brush.opacity}
        min={0.01}
        max={1}
        step={0.01}
        format={pct}
        onChange={(opacity) => setBrush({ opacity })}
      />
      <Slider
        label={t('toolOptions.flow')}
        value={brush.flow}
        min={0.01}
        max={1}
        step={0.01}
        format={pct}
        onChange={(flow) => setBrush({ flow })}
      />
      <label className="opt-check">
        <input
          type="checkbox"
          checked={brush.pressureSize}
          onChange={(e) => setBrush({ pressureSize: e.target.checked })}
        />
        {t('toolOptions.pressureSize')}
      </label>
    </div>
  )
}
