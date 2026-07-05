import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEditorStore } from '../stores/editorStore'
import { importBrushFiles, type BrushPreset } from '../io/brushes'

/** Кэш превью мазков: id пресета → dataURL. */
const previewCache = new Map<string, string>()

/**
 * Превью мазка как в Photoshop: светлый сужающийся штрих на тёмном фоне,
 * слева толсто → справа тонко (нажим), лёгкая волна.
 */
async function renderStrokePreview(preset: BrushPreset, w = 210, h = 34): Promise<string> {
  const cached = previewCache.get(preset.id)
  if (cached) return cached

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!

  let tip: ImageBitmap | null = null
  if (preset.tipPng) {
    const bin = Uint8Array.from(atob(preset.tipPng), (c) => c.charCodeAt(0))
    const raw = await createImageBitmap(new Blob([bin as BlobPart]))
    // Серый типс (белое = краска) → светлый альфа-штамп.
    const tc = new OffscreenCanvas(raw.width, raw.height)
    const tctx = tc.getContext('2d')!
    tctx.drawImage(raw, 0, 0)
    const img = tctx.getImageData(0, 0, raw.width, raw.height)
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i + 3] = img.data[i]!
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 225
    }
    tctx.putImageData(img, 0, 0)
    tip = tc.transferToImageBitmap()
  }

  const p = preset.params
  const steps = 110
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = 6 + t * (w - 12)
    const y = h / 2 + Math.sin(t * Math.PI * 1.6 + 0.4) * (h / 5)
    // Слева толсто → справа сходит на нет (как в PS).
    const taper = Math.min(1, (1 - t) * 1.6 + 0.08)
    const size = Math.max(1.5, Math.min(h * 0.85, p.size * 0.5) * taper)
    ctx.globalAlpha = Math.min(1, p.flow * 0.75 + 0.2)

    if (tip) {
      ctx.drawImage(tip, x - size / 2, y - size / 2, size, size)
    } else {
      const g = ctx.createRadialGradient(x, y, (size / 2) * Math.min(p.hardness, 0.94), x, y, size / 2)
      g.addColorStop(0, 'rgba(225,225,228,1)')
      g.addColorStop(1, 'rgba(225,225,228,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, size / 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const url = URL.createObjectURL(blob)
  previewCache.set(preset.id, url)
  return url
}

/**
 * Пикер кистей в духе Photoshop: слайдеры Размер/Жёсткость сверху,
 * сворачиваемые группы, карточки «имя + светлый мазок». Общий для
 * кисти и ластика.
 */
export function BrushPopup(props: { onClose: () => void; forEraser?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const presets = useEditorStore((s) => s.presets)
  const activePresetId = useEditorStore((s) => s.activePresetId)
  const applyPreset = useEditorStore((s) => s.applyPreset)
  const setPresets = useEditorStore((s) => s.setPresets)
  const setToast = useEditorStore((s) => s.setToast)
  const brush = useEditorStore((s) => s.brush)
  const setBrush = useEditorStore((s) => s.setBrush)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    builtin: true,
    imported: true,
  })

  useEffect(() => {
    void (async () => {
      const out: Record<string, string> = {}
      for (const preset of presets) {
        out[preset.id] = await renderStrokePreview(preset)
      }
      setPreviews(out)
    })()
  }, [presets])

  const groups: { key: string; label: string; items: BrushPreset[] }[] = [
    {
      key: 'builtin',
      label: t('brushes.groupBuiltin'),
      items: presets.filter((p) => p.id.startsWith('builtin-')),
    },
    {
      key: 'imported',
      label: t('brushes.groupImported'),
      items: presets.filter((p) => !p.id.startsWith('builtin-')),
    },
  ]

  return (
    <div className="brush-popup">
      <div className="brush-popup-sliders">
        <label className="opt-row">
          <span className="opt-label">{t('toolOptions.size')}</span>
          <input
            type="range"
            min={1}
            max={500}
            value={brush.size}
            onChange={(e) => setBrush({ size: Number(e.target.value) })}
          />
          <input
            className="num-input"
            type="number"
            min={1}
            max={500}
            value={brush.size}
            onChange={(e) => setBrush({ size: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })}
          />
          <span className="opt-label">px</span>
        </label>
        <label className="opt-row">
          <span className="opt-label">{t('toolOptions.hardness')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(brush.hardness * 100)}
            onChange={(e) => setBrush({ hardness: Number(e.target.value) / 100 })}
          />
          <input
            className="num-input"
            type="number"
            min={0}
            max={100}
            value={Math.round(brush.hardness * 100)}
            onChange={(e) =>
              setBrush({ hardness: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 })
            }
          />
          <span className="opt-label">%</span>
        </label>
      </div>

      <div className="brush-preset-list">
        {groups.map(
          (group) =>
            group.items.length > 0 && (
              <div key={group.key}>
                <button
                  className="brush-group-head"
                  onClick={() => setOpenGroups((s) => ({ ...s, [group.key]: !s[group.key] }))}
                >
                  <span className="brush-group-arrow">{openGroups[group.key] ? '▾' : '▸'}</span>
                  <span className="brush-group-folder">🗀</span>
                  {group.label}
                </button>
                {openGroups[group.key] && (
                  <div className="brush-grid">
                    {group.items.map((p) => (
                      <button
                        key={p.id}
                        className={`brush-card ${p.id === activePresetId ? 'active' : ''}`}
                        title={`${p.name} · ${p.params.size}px`}
                        onClick={() => applyPreset(p.id)}
                      >
                        <span className="brush-card-name">{p.name}</span>
                        {previews[p.id] ? (
                          <img src={previews[p.id]} alt="" draggable={false} />
                        ) : (
                          <span className="preview-stub" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ),
        )}
      </div>

      <div className="brush-popup-foot">
        <button
          className="style-btn wide"
          title={t('brushes.import')}
          onClick={() =>
            void importBrushFiles().then(({ added, skipped }) => {
              if (added.length > 0) setPresets([...useEditorStore.getState().presets, ...added])
              setToast(t('brushes.importResult', { added: added.length, skipped }))
            })
          }
        >
          ⤓ {t('brushes.importShort')}
        </button>
        <span className="spacer" />
        <button className="style-btn" onClick={props.onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}
