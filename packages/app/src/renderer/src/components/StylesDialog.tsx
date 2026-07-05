import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_COLOR_OVERLAY,
  DEFAULT_GAUSSIAN_BLUR,
  DEFAULT_GLOW,
  DEFAULT_MOTION_BLUR,
  DEFAULT_SHADOW,
  type BlurStyle,
  type ColorOverlayStyle,
  type GlowStyle,
  type LayerStyles,
  type MotionBlurStyle,
  type ShadowStyle,
} from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

function ShadowEditor(props: {
  title: string
  value: ShadowStyle | undefined
  onChange: (v: ShadowStyle | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const v = props.value
  const set = (patch: Partial<ShadowStyle>): void =>
    props.onChange({ ...(v ?? DEFAULT_SHADOW), ...patch })

  return (
    <fieldset className="style-group">
      <legend>
        <label className="opt-check">
          <input
            type="checkbox"
            checked={v?.enabled ?? false}
            onChange={(e) =>
              e.target.checked ? set({ enabled: true }) : v && props.onChange({ ...v, enabled: false })
            }
          />
          {props.title}
        </label>
      </legend>
      {v?.enabled && (
        <>
          <div className="dialog-row">
            <span>{t('styles.color')}</span>
            <input
              type="color"
              className="color-input"
              value={v.color}
              onChange={(e) => set({ color: e.target.value })}
            />
            <span>{t('styles.opacity')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={v.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
            />
          </div>
          <div className="dialog-row">
            <span>{t('styles.distance')}</span>
            <input
              type="number"
              min={0}
              max={500}
              value={v.distance}
              onChange={(e) => set({ distance: Number(e.target.value) || 0 })}
            />
            <span>{t('styles.angle')}</span>
            <input
              type="number"
              min={-180}
              max={360}
              value={v.angle}
              onChange={(e) => set({ angle: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="dialog-row">
            <span>{t('styles.size')}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={v.size}
              onChange={(e) => set({ size: Number(e.target.value) })}
            />
            <span className="opt-value">{v.size}px</span>
          </div>
          <div className="dialog-row">
            <span>{t('styles.spread')}</span>
            <input
              type="range"
              min={0}
              max={50}
              value={Math.round(v.spread ?? 0)}
              onChange={(e) => set({ spread: Number(e.target.value) })}
            />
            <span className="opt-value">{Math.round(v.spread ?? 0)}px</span>
          </div>
        </>
      )}
    </fieldset>
  )
}

function GlowEditor(props: {
  title: string
  value: GlowStyle | undefined
  onChange: (v: GlowStyle | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const v = props.value
  const set = (patch: Partial<GlowStyle>): void => props.onChange({ ...(v ?? DEFAULT_GLOW), ...patch })

  return (
    <fieldset className="style-group">
      <legend>
        <label className="opt-check">
          <input
            type="checkbox"
            checked={v?.enabled ?? false}
            onChange={(e) =>
              e.target.checked ? set({ enabled: true }) : v && props.onChange({ ...v, enabled: false })
            }
          />
          {props.title}
        </label>
      </legend>
      {v?.enabled && (
        <>
          <div className="dialog-row">
            <span>{t('styles.color')}</span>
            <input
              type="color"
              className="color-input"
              value={v.color}
              onChange={(e) => set({ color: e.target.value })}
            />
            <span>{t('styles.opacity')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={v.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
            />
          </div>
          <div className="dialog-row">
            <span>{t('styles.size')}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={v.size}
              onChange={(e) => set({ size: Number(e.target.value) })}
            />
            <span className="opt-value">{v.size}px</span>
          </div>
          <div className="dialog-row">
            <span>{t('styles.spread')}</span>
            <input
              type="range"
              min={0}
              max={50}
              value={Math.round(v.spread ?? 0)}
              onChange={(e) => set({ spread: Number(e.target.value) })}
            />
            <span className="opt-value">{Math.round(v.spread ?? 0)}px</span>
          </div>
        </>
      )}
    </fieldset>
  )
}

function ColorOverlayEditor(props: {
  title: string
  value: ColorOverlayStyle | undefined
  onChange: (v: ColorOverlayStyle | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const v = props.value
  const set = (patch: Partial<ColorOverlayStyle>): void =>
    props.onChange({ ...(v ?? DEFAULT_COLOR_OVERLAY), ...patch })

  return (
    <fieldset className="style-group">
      <legend>
        <label className="opt-check">
          <input
            type="checkbox"
            checked={v?.enabled ?? false}
            onChange={(e) =>
              e.target.checked ? set({ enabled: true }) : v && props.onChange({ ...v, enabled: false })
            }
          />
          {props.title}
        </label>
      </legend>
      {v?.enabled && (
        <div className="dialog-row">
          <span>{t('styles.color')}</span>
          <input
            type="color"
            className="color-input"
            value={v.color}
            onChange={(e) => set({ color: e.target.value })}
          />
          <span>{t('styles.opacity')}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={v.opacity}
            onChange={(e) => set({ opacity: Number(e.target.value) })}
          />
          <span className="opt-value">{Math.round(v.opacity * 100)}%</span>
        </div>
      )}
    </fieldset>
  )
}

function GaussianBlurEditor(props: {
  title: string
  value: BlurStyle | undefined
  onChange: (v: BlurStyle | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const v = props.value
  const set = (patch: Partial<BlurStyle>): void =>
    props.onChange({ ...(v ?? DEFAULT_GAUSSIAN_BLUR), ...patch })

  return (
    <fieldset className="style-group">
      <legend>
        <label className="opt-check">
          <input
            type="checkbox"
            checked={v?.enabled ?? false}
            onChange={(e) =>
              e.target.checked ? set({ enabled: true }) : v && props.onChange({ ...v, enabled: false })
            }
          />
          {props.title}
        </label>
      </legend>
      {v?.enabled && (
        <div className="dialog-row">
          <span>{t('styles.blurRadius')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={v.radius}
            onChange={(e) => set({ radius: Number(e.target.value) })}
          />
          <span className="opt-value">{v.radius}px</span>
        </div>
      )}
    </fieldset>
  )
}

function MotionBlurEditor(props: {
  title: string
  value: MotionBlurStyle | undefined
  onChange: (v: MotionBlurStyle | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const v = props.value
  const set = (patch: Partial<MotionBlurStyle>): void =>
    props.onChange({ ...(v ?? DEFAULT_MOTION_BLUR), ...patch })

  return (
    <fieldset className="style-group">
      <legend>
        <label className="opt-check">
          <input
            type="checkbox"
            checked={v?.enabled ?? false}
            onChange={(e) =>
              e.target.checked ? set({ enabled: true }) : v && props.onChange({ ...v, enabled: false })
            }
          />
          {props.title}
        </label>
      </legend>
      {v?.enabled && (
        <>
          <div className="dialog-row">
            <span>{t('styles.blurDistance')}</span>
            <input
              type="range"
              min={0}
              max={300}
              value={v.distance}
              onChange={(e) => set({ distance: Number(e.target.value) })}
            />
            <span className="opt-value">{v.distance}px</span>
          </div>
          <div className="dialog-row">
            <span>{t('styles.angle')}</span>
            <input
              type="number"
              min={-180}
              max={360}
              value={v.angle}
              onChange={(e) => set({ angle: Number(e.target.value) || 0 })}
            />
          </div>
        </>
      )}
    </fieldset>
  )
}

export function StylesDialog(props: { layerId: string; onClose: () => void }): React.JSX.Element | null {
  const { t } = useTranslation()
  const docJson = useEditorStore((s) => s.docJson)
  const layer = docJson?.layers.find((l) => l.id === props.layerId)
  // Исходные стили — для отмены и корректной записи истории.
  const [original] = useState<LayerStyles | undefined>(() =>
    layer?.styles ? structuredClone(layer.styles) : undefined,
  )
  // Немодальное окно: позиция (перетаскивание за заголовок).
  const [pos, setPos] = useState({ x: Math.max(40, window.innerWidth - 760), y: 90 })
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  const onHeaderDown = (e: React.PointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y }
  }
  const onHeaderMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    setPos({ x: d.baseX + e.clientX - d.startX, y: Math.max(0, d.baseY + e.clientY - d.startY) })
  }
  const onHeaderUp = (): void => {
    dragRef.current = null
  }

  if (!layer) return null
  const styles = layer.styles

  const change = (patch: Partial<LayerStyles>): void => {
    const next: LayerStyles = { ...styles, ...patch }
    for (const key of Object.keys(next) as (keyof LayerStyles)[]) {
      if (!next[key]) delete next[key]
    }
    const empty = Object.keys(next).length === 0
    editor.setLayerStyles(props.layerId, empty ? undefined : next, false)
  }

  const ok = (): void => {
    const current = useEditorStore
      .getState()
      .docJson?.layers.find((l) => l.id === props.layerId)?.styles
    editor.commitLayerStyles(props.layerId, original, current ? structuredClone(current) : undefined)
    props.onClose()
  }

  const cancel = (): void => {
    editor.setLayerStyles(props.layerId, original, false)
    props.onClose()
  }

  return (
    <div className="styles-window" style={{ left: pos.x, top: pos.y }}>
      <div
        className="styles-window-header"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <span>
          {t('styles.title')} — {layer.name}
        </span>
        <span className="spacer" />
        <button className="style-btn" onPointerDown={(e) => e.stopPropagation()} onClick={cancel}>
          ✕
        </button>
      </div>
      <div className="styles-window-body">
        <ShadowEditor
          title={t('styles.dropShadow')}
          value={styles?.dropShadow}
          onChange={(dropShadow) => change({ dropShadow })}
        />
        <ShadowEditor
          title={t('styles.innerShadow')}
          value={styles?.innerShadow}
          onChange={(innerShadow) => change({ innerShadow })}
        />
        <GlowEditor
          title={t('styles.outerGlow')}
          value={styles?.outerGlow}
          onChange={(outerGlow) => change({ outerGlow })}
        />
        <ColorOverlayEditor
          title={t('styles.colorOverlay')}
          value={styles?.colorOverlay}
          onChange={(colorOverlay) => change({ colorOverlay })}
        />
        <GaussianBlurEditor
          title={t('styles.gaussianBlur')}
          value={styles?.gaussianBlur}
          onChange={(gaussianBlur) => change({ gaussianBlur })}
        />
        <MotionBlurEditor
          title={t('styles.motionBlur')}
          value={styles?.motionBlur}
          onChange={(motionBlur) => change({ motionBlur })}
        />
        <div className="dialog-buttons">
          <button className="primary" onClick={ok}>
            {t('common.ok')}
          </button>
          <button onClick={cancel}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

