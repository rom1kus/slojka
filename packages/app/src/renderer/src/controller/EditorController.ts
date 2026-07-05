import { Engine, type RgbaColor, type SelectionOp, type StrokePoint, type Point } from '@slojka/engine'
import {
  DEFAULT_TEXT_PARAMS,
  type BlendMode,
  type LayerStyles,
  type TextParams,
} from '@slojka/shared'
import { useEditorStore } from '../stores/editorStore'

export function hexToRgba(hex: string): RgbaColor {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255, 1]
}

/**
 * Клей между движком и UI: единственный владелец Engine.
 * Все мутации идут через него; после каждой стор получает свежий снапшот.
 */
class EditorController {
  private engine: Engine | null = null
  private canvasEl: HTMLCanvasElement | null = null
  private rafId = 0

  attach(canvas: HTMLCanvasElement): void {
    if (this.engine) return
    this.canvasEl = canvas
    this.engine = new Engine(canvas)
    this.engine.onChange = () => this.sync(true)

    const store = useEditorStore.getState()
    store.setGlInfo(this.engine.caps.renderer, this.engine.caps.software)

    const loop = (): void => {
      if (this.engine?.needsRender) this.engine.render()
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)

    // Пользовательский бюджет истории (по умолчанию 256 МБ).
    void window.slojka.getSetting('historyMb').then((v) => {
      if (typeof v === 'number') this.engine?.setHistoryBudgetMb(v)
    })
  }

  setHistoryBudgetMb(mb: number): void {
    this.engine?.setHistoryBudgetMb(mb)
  }

  detach(): void {
    cancelAnimationFrame(this.rafId)
    this.engine?.dispose()
    this.engine = null
    this.canvasEl = null
  }

  get attached(): boolean {
    return this.engine !== null
  }

  // ── Документ ──
  newDocument(width: number, height: number, background: 'transparent' | 'white'): void {
    this.engine?.newDocument(width, height, background)
    this.zoomFit()
  }

  // ── Слои ──
  addLayer(name: string): void {
    this.engine?.addLayer(name)
  }
  deleteLayer(id: string): void {
    this.engine?.deleteLayer(id)
  }
  setActiveLayer(id: string): void {
    this.engine?.setActiveLayer(id)
  }
  setLayerVisible(id: string, visible: boolean): void {
    this.engine?.setLayerProps(id, { visible })
  }
  setLayerOpacity(id: string, opacity: number, commit: boolean): void {
    this.engine?.setLayerProps(id, { opacity }, { history: commit })
  }
  setLayerBlendMode(id: string, blendMode: BlendMode): void {
    this.engine?.setLayerProps(id, { blendMode })
  }
  setLayerClipped(id: string, clipped: boolean): void {
    this.engine?.setLayerProps(id, { clipped })
  }
  renameLayer(id: string, name: string): void {
    this.engine?.setLayerProps(id, { name })
  }
  moveLayer(id: string, toIndex: number): void {
    this.engine?.moveLayer(id, toIndex)
  }

  setLayerStyles(id: string, styles: LayerStyles | undefined, commit = true): void {
    this.engine?.setLayerStyles(id, styles, { history: commit })
  }

  /** Коммит серии live-правок стилей одной записью истории. */
  commitLayerStyles(id: string, before: LayerStyles | undefined, after: LayerStyles | undefined): void {
    this.engine?.setLayerStyles(id, before, { history: false })
    this.engine?.setLayerStyles(id, after, { history: true })
  }

  flattenImage(): void {
    this.engine?.flattenImage()
  }

  clearSelectedArea(): void {
    this.engine?.clearSelectedArea()
  }

  /** Переход по истории: положительное n — undo n раз, отрицательное — redo. */
  jumpHistory(steps: number): void {
    if (!this.engine) return
    for (let i = 0; i < Math.abs(steps); i++) {
      if (steps > 0) this.engine.undo()
      else this.engine.redo()
    }
  }

  // ── Маски ──
  addLayerMask(id: string): void {
    const useSelection = this.engine?.hasSelection ?? false
    this.engine?.addLayerMask(id, useSelection)
  }
  removeLayerMask(id: string): void {
    this.engine?.removeLayerMask(id)
  }
  setMaskEditing(layerId: string | null): void {
    this.engine?.setMaskEditing(layerId)
  }

  // ── Выделение ──
  private currentOp(e?: { shiftKey: boolean; altKey: boolean }): SelectionOp {
    if (e?.shiftKey && e?.altKey) return 'intersect'
    if (e?.shiftKey) return 'add'
    if (e?.altKey) return 'subtract'
    return useEditorStore.getState().selectionOp
  }

  selectRectCss(x0: number, y0: number, x1: number, y1: number, mods?: { shiftKey: boolean; altKey: boolean }): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    // Клик без протяжки — пустая рамка: как в PS, просто снимаем выделение.
    // Иначе остаётся активное выделение с нулевой маской, и кисти «не рисуют».
    if (Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2) {
      engine.deselect()
      return
    }
    const a = engine.viewToDoc(Math.min(x0, x1), Math.min(y0, y1))
    const b = engine.viewToDoc(Math.max(x0, x1), Math.max(y0, y1))
    engine.selectRect(a.x, a.y, b.x - a.x, b.y - a.y, this.currentOp(mods))
  }

  selectEllipseCss(x0: number, y0: number, x1: number, y1: number, mods?: { shiftKey: boolean; altKey: boolean }): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    if (Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2) {
      engine.deselect()
      return
    }
    const a = engine.viewToDoc(Math.min(x0, x1), Math.min(y0, y1))
    const b = engine.viewToDoc(Math.max(x0, x1), Math.max(y0, y1))
    engine.selectEllipse((a.x + b.x) / 2, (a.y + b.y) / 2, (b.x - a.x) / 2, (b.y - a.y) / 2, this.currentOp(mods))
  }

  selectPolygonCss(cssPoints: { x: number; y: number }[], mods?: { shiftKey: boolean; altKey: boolean }): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    const points: Point[] = cssPoints.map((p) => engine.viewToDoc(p.x, p.y))
    engine.selectPolygon(points, this.currentOp(mods))
  }

  selectWandCss(cssX: number, cssY: number, mods?: { shiftKey: boolean; altKey: boolean }): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    const p = engine.viewToDoc(cssX, cssY)
    engine.selectWand(p.x, p.y, useEditorStore.getState().wandTolerance, this.currentOp(mods))
  }

  selectAll(): void {
    this.engine?.selectAll()
  }
  deselect(): void {
    this.engine?.deselect()
  }
  invertSelection(): void {
    this.engine?.invertSelection()
  }
  featherSelection(px: number): void {
    this.engine?.featherSelection(px)
  }

  /** Размер холста: (dx, dy) — позиция старого левого верха в новом холсте. */
  resizeCanvas(width: number, height: number, dx: number, dy: number, label?: string): void {
    this.engine?.resizeCanvas(width, height, dx, dy, label)
  }

  // ── Текст ──
  addTextLayerAt(cssX: number, cssY: number, cssBox?: { w: number; h: number }): string | null {
    const engine = this.engine
    if (!engine?.hasDocument) return null
    const p = engine.viewToDoc(cssX, cssY)
    const { color } = useEditorStore.getState()
    const scale = engine.view.scale
    const params: TextParams = {
      ...DEFAULT_TEXT_PARAMS,
      content: '',
      color,
      x: Math.round(p.x),
      y: Math.round(p.y),
      // Paragraph text: фиксированная область (как в Photoshop).
      ...(cssBox
        ? {
            boxW: Math.max(40, Math.round(cssBox.w / scale)),
            boxH: Math.max(24, Math.round(cssBox.h / scale)),
          }
        : {}),
    }
    return engine.addTextLayer('Текст', params)
  }

  setTextParams(id: string, patch: Partial<TextParams>, commit = true): void {
    this.engine?.setTextParams(id, patch, { history: commit })
  }

  private textMoveStart: { id: string; x: number; y: number } | null = null

  beginTextMove(id: string): void {
    const layer = this.engine?.getDocumentJson()?.layers.find((l) => l.id === id)
    if (layer?.kind === 'text') {
      this.textMoveStart = { id, x: layer.text.x, y: layer.text.y }
    }
  }

  moveTextLayerBy(id: string, cssDx: number, cssDy: number): void {
    const engine = this.engine
    const doc = engine?.getDocumentJson()
    const layer = doc?.layers.find((l) => l.id === id)
    if (!engine || !layer || layer.kind !== 'text') return
    const scale = engine.view.scale
    engine.setTextParams(
      id,
      { x: layer.text.x + cssDx / scale, y: layer.text.y + cssDy / scale },
      { history: false },
    )
  }

  /**
   * Одна запись истории на серию live-правок (набор текста, перемещение):
   * откат к значениям до серии без истории, затем применение с историей.
   */
  commitTextChange(id: string, before: Partial<TextParams>, after: Partial<TextParams>): void {
    this.engine?.setTextParams(id, before, { history: false })
    this.engine?.setTextParams(id, after, { history: true })
  }

  /** Одна запись истории на всё перемещение: откат к старту, применение с историей. */
  commitTextMove(id: string): void {
    const start = this.textMoveStart
    this.textMoveStart = null
    const layer = this.engine?.getDocumentJson()?.layers.find((l) => l.id === id)
    if (!start || start.id !== id || !layer || layer.kind !== 'text') return
    const end = { x: layer.text.x, y: layer.text.y }
    if (start.x === end.x && start.y === end.y) return
    this.engine!.setTextParams(id, { x: start.x, y: start.y }, { history: false })
    this.engine!.setTextParams(id, end, { history: true })
  }

  // ── Штрих ──
  beginStroke(mode: 'brush' | 'erase', cssX: number, cssY: number, pressure: number): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    const s = useEditorStore.getState()
    const p = engine.viewToDoc(cssX, cssY)
    engine.beginStroke(mode, s.brush, hexToRgba(s.color), {
      x: p.x,
      y: p.y,
      pressure: pressure || 0.5,
    })
  }

  strokeTo(cssX: number, cssY: number, pressure: number): void {
    const engine = this.engine
    if (!engine?.isStroking) return
    const p = engine.viewToDoc(cssX, cssY)
    const point: StrokePoint = { x: p.x, y: p.y, pressure: pressure || 0.5 }
    engine.strokeTo(point)
  }

  endStroke(): void {
    this.engine?.endStroke()
  }

  beginSelectionStroke(op: 'add' | 'subtract', cssX: number, cssY: number, pressure: number): void {
    const engine = this.engine
    if (!engine?.hasDocument) return
    const s = useEditorStore.getState()
    const p = engine.viewToDoc(cssX, cssY)
    engine.beginSelectionStroke(op, s.brush, { x: p.x, y: p.y, pressure: pressure || 0.5 })
  }

  get isStroking(): boolean {
    return this.engine?.isStroking ?? false
  }

  // ── Floating / трансформация выделения ──
  liftSelection(): boolean {
    return this.engine?.liftSelection() ?? false
  }
  setFloatingTransform(patch: Parameters<Engine['setFloatingTransform']>[0]): void {
    this.engine?.setFloatingTransform(patch)
  }
  commitFloating(): void {
    this.engine?.commitFloating()
  }
  cancelFloating(): void {
    this.engine?.cancelFloating()
  }
  deleteFloating(): void {
    this.engine?.deleteFloating()
  }
  getSmartInfo(id: string) {
    return this.engine?.getSmartInfo(id) ?? null
  }
  convertToSmart(id: string): boolean {
    return this.engine?.convertToSmart(id) ?? false
  }
  beginSelectionAdjust(): boolean {
    return this.engine?.beginSelectionAdjust() ?? false
  }
  previewSelectionAdjust(feather: number, expand: number): void {
    this.engine?.previewSelectionAdjust(feather, expand)
  }
  commitSelectionAdjust(feather: number, expand: number): void {
    this.engine?.commitSelectionAdjust(feather, expand)
  }
  setSmartTransform(id: string, patch: Record<string, number>, commit: boolean): void {
    this.engine?.setSmartTransform(id, patch, { history: commit })
  }
  /** Одна запись истории на серию live-правок smart-трансформа. */
  commitSmartTransform(id: string, before: Record<string, number>, after: Record<string, number>): void {
    this.engine?.setSmartTransform(id, before, { history: false })
    this.engine?.setSmartTransform(id, after, { history: true })
  }
  get floatingState() {
    return this.engine?.floatingState ?? null
  }
  copySelectionToLayer(): void {
    this.engine?.copySelectionToLayer()
  }
  duplicateLayer(id: string): void {
    this.engine?.duplicateLayer(id)
  }
  mergeLayers(ids: string[]): void {
    this.engine?.mergeLayers(ids)
  }
  /** Свести видимое (ПКМ по панели слоёв). */
  mergeVisible(): void {
    const doc = this.engine?.getDocumentJson()
    if (!doc) return
    const visible = doc.layers.filter((l) => l.visible).map((l) => l.id)
    if (visible.length >= 2) this.engine?.mergeLayers(visible)
  }
  /** Ctrl+E без мультивыбора: объединить с нижним слоем. */
  mergeDown(): void {
    const doc = this.engine?.getDocumentJson()
    if (!doc?.activeLayerId) return
    const i = doc.layers.findIndex((l) => l.id === doc.activeLayerId)
    if (i > 0) this.engine?.mergeLayers([doc.layers[i - 1]!.id, doc.layers[i]!.id])
  }
  selectFromLayerAlpha(id: string): void {
    this.engine?.selectFromLayerAlpha(id)
  }

  // ── Внутренний буфер обмена (Ctrl+C/X/V, вставка новым слоем) ──
  private clipboard: {
    pixels: Uint8Array
    width: number
    height: number
    styles?: LayerStyles
  } | null = null

  copySelection(): boolean {
    // Незакоммиченный floating сначала прижигаем — копируем то, что видно.
    if (this.engine?.hasFloating) this.engine.commitFloating()
    const data = this.engine?.copySelectedPixels() ?? null
    if (data) {
      // Стили исходного слоя едут вместе с пикселями — вставка их сохранит.
      const doc = this.engine?.getDocumentJson()
      const active = doc?.layers.find((l) => l.id === doc.activeLayerId)
      this.clipboard = {
        ...data,
        ...(active?.styles ? { styles: structuredClone(active.styles) } : {}),
      }
    }
    return data !== null
  }

  cutSelection(): boolean {
    if (!this.copySelection()) return false
    if (this.engine?.hasSelection) this.engine.clearSelectedArea()
    return true
  }

  pasteAsLayer(): boolean {
    if (!this.clipboard) return false
    this.engine?.pasteAsLayer(
      this.clipboard.pixels,
      this.clipboard.width,
      this.clipboard.height,
      undefined,
      this.clipboard.styles,
    )
    return true
  }

  // ── Миниатюры слоёв ──
  private thumbVersions = new Map<string, number>()
  private thumbUrls = new Map<string, string>()

  /** Обновляет dataURL-миниатюры изменившихся слоёв (вызывается из sync). */
  private refreshThumbs(): Record<string, string> {
    const engine = this.engine
    if (!engine?.hasDocument) {
      this.thumbVersions.clear()
      this.thumbUrls.clear()
      return {}
    }
    const versions = engine.getLayerVersions()
    for (const [id, version] of Object.entries(versions)) {
      if (this.thumbVersions.get(id) === version) continue
      const thumb = engine.getLayerThumbnail(id, 40)
      if (!thumb) continue
      const canvas = document.createElement('canvas')
      canvas.width = thumb.w
      canvas.height = thumb.h
      const data = new Uint8ClampedArray(thumb.pixels.length)
      for (let i = 0; i < data.length; i += 4) {
        const a = thumb.pixels[i + 3]!
        const k = a ? 255 / a : 0
        data[i] = thumb.pixels[i]! * k
        data[i + 1] = thumb.pixels[i + 1]! * k
        data[i + 2] = thumb.pixels[i + 2]! * k
        data[i + 3] = a
      }
      canvas.getContext('2d')!.putImageData(new ImageData(data, thumb.w, thumb.h), 0, 0)
      this.thumbUrls.set(id, canvas.toDataURL())
      this.thumbVersions.set(id, version)
    }
    // Подчистить удалённые слои.
    for (const id of [...this.thumbUrls.keys()]) {
      if (!(id in versions)) {
        this.thumbUrls.delete(id)
        this.thumbVersions.delete(id)
      }
    }
    return Object.fromEntries(this.thumbUrls)
  }

  // ── Кисти ──
  registerBrushTip(id: string, coverage: Uint8Array, w: number, h: number): void {
    this.engine?.registerBrushTip(id, coverage, w, h)
  }

  /** Прямой доступ к движку для файловых модулей (io/). */
  get engineForIo(): Engine {
    if (!this.engine) throw new Error('Движок не инициализирован')
    return this.engine
  }

  // ── История ──
  undo(): void {
    this.engine?.undo()
  }
  redo(): void {
    this.engine?.redo()
  }

  // ── Вид ──
  resizeDisplay(cssW: number, cssH: number, dpr: number): void {
    this.engine?.resizeDisplay(cssW, cssH, dpr)
  }

  panBy(dx: number, dy: number): void {
    const v = this.engine?.view
    if (!v) return
    this.engine!.setView({ panX: v.panX + dx, panY: v.panY + dy })
  }

  zoomAt(cssX: number, cssY: number, factor: number): void {
    this.engine?.zoomAt(cssX, cssY, factor)
    this.sync()
  }

  zoomFit(): void {
    const el = this.canvasEl
    if (!el || !this.engine) return
    const rect = el.getBoundingClientRect()
    this.engine.zoomFit(rect.width, rect.height)
    this.sync()
  }

  zoomActual(): void {
    this.engine?.setView({ scale: 1 })
    this.sync()
  }

  getView(): { panX: number; panY: number; scale: number } {
    return this.engine?.view ?? { panX: 0, panY: 0, scale: 1 }
  }

  zoomStep(factor: number): void {
    const el = this.canvasEl
    if (!el) return
    const rect = el.getBoundingClientRect()
    this.zoomAt(rect.width / 2, rect.height / 2, factor)
  }

  private sync(markDirty = false): void {
    const engine = this.engine
    if (!engine) return
    const store = useEditorStore.getState()
    store.syncFromEngine({
      docJson: engine.getDocumentJson(),
      canUndo: engine.canUndo,
      canRedo: engine.canRedo,
      zoom: engine.view.scale,
      hasSelection: engine.hasSelection,
      maskEditLayerId: engine.maskEditLayerId,
      historyLabels: engine.getHistoryLabels(),
      layerThumbs: this.refreshThumbs(),
    })
    if (markDirty && engine.hasDocument) store.setDirty(true)
  }
}

export const editor = new EditorController()
