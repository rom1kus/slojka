import {
  BLEND_MODES,
  CANVAS_LIMITS,
  adjustStyleRanges,
  newLayerId,
  type BlendMode,
  type DocumentJson,
  type LayerJson,
  type LayerStyles,
  type ShadowStyle,
  type SmartTransform,
  type TextParams,
} from '@slojka/shared'
import { GlContext } from './gl/context'
import { Fbo } from './gl/fbo'
import { Program } from './gl/shader'
import { Quad, FULL_RECT } from './gl/quad'
import { Texture } from './gl/texture'
import {
  FRAG_ANTS,
  FRAG_BLEND,
  FRAG_COLOR_OVERLAY,
  FRAG_COPY,
  FRAG_DAB,
  FRAG_DAB_TIP,
  FRAG_FILL,
  FRAG_GAUSS,
  FRAG_GAUSS_RGBA,
  FRAG_INVERT,
  FRAG_MOTION,
  FRAG_MERGE,
  FRAG_MERGE_MASK,
  FRAG_PLACE,
  FRAG_PRESENT,
  FRAG_SEL_COMBINE,
  FRAG_EXTRACT,
  FRAG_FLOAT,
  FRAG_SHADOW_COLOR,
  FRAG_SHADOW_MASK,
  FRAG_THRESHOLD,
  VERT,
} from './gl/shaders'
import { History, PixelPatch, type Rect } from './history/history'
import { StrokeLayout } from './brush/stroke'
import type { BrushParams, StrokePoint } from './brush/types'
import {
  magicWand,
  rasterEllipse,
  rasterPolygon,
  rasterRect,
  type Point,
  type SelectionOp,
} from './selection/shapes'
import { rasterizeText } from './text/rasterize'

export type RgbaColor = readonly [number, number, number, number]
export type StrokeTarget = 'pixels' | 'mask'

export interface View {
  panX: number
  panY: number
  scale: number
}

interface LayerRuntime {
  json: LayerJson
  texture: Texture
  mask: Texture | null
  /** Оригинал smart-слоя (полное разрешение). */
  source: Texture | null
  /** Растёт при каждом изменении пикселей — для кэша миниатюр в UI. */
  version: number
  /** Кэш размытого слоя (стили размытия): пересчёт только при изменениях. */
  blurTex?: Texture | null
  blurKey?: string
}

/** Плавающий фрагмент (перемещение/трансформация выделенного). */
export interface FloatingState {
  layerId: string
  bbox: Rect
  cx: number
  cy: number
  dx: number
  dy: number
  sx: number
  sy: number
  rot: number
}

interface FloatingRuntime extends FloatingState {
  tex: Texture
  selTex: Texture
  backupLayer: PixelPatch
  backupSel: PixelPatch
  wasSelActive: boolean
}

interface ActiveStroke {
  layerId: string
  target: StrokeTarget | 'selection'
  mode: 'brush' | 'erase'
  /** Для target='selection': добавить или вычесть из выделения. */
  selOp?: 'add' | 'subtract'
  brush: BrushParams
  color: RgbaColor
  layout: StrokeLayout
  dirty: Rect | null
}

interface DocRuntime {
  width: number
  height: number
  layers: LayerRuntime[]
  activeLayerId: string | null
  accumA: Fbo
  accumB: Fbo
  scratch: Fbo
  strokeTex: Texture
  strokeFbo: Fbo
  /** FBO без своей текстуры — для чтения/записи в произвольную текстуру. */
  attachFbo: Fbo
  composite: Texture
  // Выделение: текущее + два служебных R8.
  selCur: Texture
  selScratch: Texture
  selShape: Texture
  selFbo: Fbo
  selActive: boolean
  // Скретчи стилей слоя (тени): не пересекаются с выделением/штрихом.
  styleA: Texture
  styleB: Texture
  styleColor: Texture
  // RGBA-скретчи размытий слоя (гаусс/движение): создаются по требованию.
  blurA: Texture | null
  blurB: Texture | null
  /** Уменьшенные скретчи для больших радиусов (ключ — фактор даунсемпла). */
  blurSmall: Map<number, { a: Texture; b: Texture }>
}

const OP_INDEX: Record<SelectionOp, number> = { replace: 0, add: 1, subtract: 2, intersect: 3 }

const MODE_INDEX: Record<BlendMode, number> = Object.fromEntries(
  BLEND_MODES.map((m, i) => [m, i]),
) as Record<BlendMode, number>

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

/** Ограничивающий прямоугольник непустой части R8-маски (порог 8). */
function maskBounds(mask: Uint8Array, w: number, h: number): Rect | null {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (mask[row + x]! > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * Движок: владеет пикселями (текстурами), структурой слоёв, выделением
 * и историей. UI получает снапшот структуры через getDocumentJson().
 */
export class Engine {
  private ctx: GlContext
  private quad: Quad
  private progBlend: Program
  private progDab: Program
  private progDabTip: Program
  private progMerge: Program
  private progMergeMask: Program
  private progPresent: Program
  private progFill: Program
  private progCopy: Program
  private progSelCombine: Program
  private progInvert: Program
  private progGauss: Program
  private progGaussRgba: Program
  private progMotion: Program
  private progColorOverlay: Program
  private progAnts: Program
  private progShadowMask: Program
  private progShadowColor: Program
  private progExtract: Program
  private progFloat: Program
  private progPlace: Program
  private progThreshold: Program

  private doc: DocRuntime | null = null
  private stroke: ActiveStroke | null = null
  private floating: FloatingRuntime | null = null
  private history: History

  view: View = { panX: 0, panY: 0, scale: 1 }
  private dpr = 1
  private compositeDirty = true
  private presentQueued = false
  /** id слоя, маску которого сейчас редактируют (кисть пишет в маску). */
  maskEditLayerId: string | null = null

  /** Реестр типсов текстурных кистей (живут вне документа). */
  private brushTips = new Map<string, Texture>()

  /** Вызывается после каждого изменения структуры/истории — UI обновляет стор. */
  onChange: (() => void) | null = null

  constructor(private canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.ctx = new GlContext(canvas)
    const gl = this.ctx.gl
    this.quad = new Quad(gl)
    this.progBlend = new Program(gl, VERT, FRAG_BLEND, 'blend')
    this.progDab = new Program(gl, VERT, FRAG_DAB, 'dab')
    this.progDabTip = new Program(gl, VERT, FRAG_DAB_TIP, 'dabTip')
    this.progMerge = new Program(gl, VERT, FRAG_MERGE, 'merge')
    this.progMergeMask = new Program(gl, VERT, FRAG_MERGE_MASK, 'mergeMask')
    this.progPresent = new Program(gl, VERT, FRAG_PRESENT, 'present')
    this.progFill = new Program(gl, VERT, FRAG_FILL, 'fill')
    this.progCopy = new Program(gl, VERT, FRAG_COPY, 'copy')
    this.progSelCombine = new Program(gl, VERT, FRAG_SEL_COMBINE, 'selCombine')
    this.progInvert = new Program(gl, VERT, FRAG_INVERT, 'invert')
    this.progGauss = new Program(gl, VERT, FRAG_GAUSS, 'gauss')
    this.progGaussRgba = new Program(gl, VERT, FRAG_GAUSS_RGBA, 'gaussRgba')
    this.progMotion = new Program(gl, VERT, FRAG_MOTION, 'motion')
    this.progColorOverlay = new Program(gl, VERT, FRAG_COLOR_OVERLAY, 'colorOverlay')
    this.progAnts = new Program(gl, VERT, FRAG_ANTS, 'ants')
    this.progShadowMask = new Program(gl, VERT, FRAG_SHADOW_MASK, 'shadowMask')
    this.progShadowColor = new Program(gl, VERT, FRAG_SHADOW_COLOR, 'shadowColor')
    this.progExtract = new Program(gl, VERT, FRAG_EXTRACT, 'extract')
    this.progFloat = new Program(gl, VERT, FRAG_FLOAT, 'float')
    this.progPlace = new Program(gl, VERT, FRAG_PLACE, 'place')
    this.progThreshold = new Program(gl, VERT, FRAG_THRESHOLD, 'threshold')
    this.history = new History(256 * 1024 * 1024, 200, () => this.emit())
  }

  /** Бюджет памяти истории (настройка), МБ. */
  setHistoryBudgetMb(mb: number): void {
    this.history.setBudget(mb * 1024 * 1024)
  }

  get caps() {
    return this.ctx.caps
  }
  get hasDocument(): boolean {
    return this.doc !== null
  }
  get canUndo(): boolean {
    return this.history.canUndo
  }
  get canRedo(): boolean {
    return this.history.canRedo
  }
  get undoLabel(): string | null {
    return this.history.undoLabel
  }
  get redoLabel(): string | null {
    return this.history.redoLabel
  }
  get hasSelection(): boolean {
    return this.doc?.selActive ?? false
  }

  // ───────────────────────── Документ ─────────────────────────

  newDocument(width: number, height: number, background: 'transparent' | 'white'): void {
    this.disposeDoc()
    const gl = this.ctx.gl

    const accumA = new Fbo(gl, new Texture(gl, width, height))
    const accumB = new Fbo(gl, new Texture(gl, width, height))
    const scratch = new Fbo(gl, new Texture(gl, width, height))
    const strokeTex = new Texture(gl, width, height, 'r8')
    const strokeFbo = new Fbo(gl, strokeTex)
    const attachFbo = new Fbo(gl, accumA.texture)
    const selCur = new Texture(gl, width, height, 'r8')
    const selScratch = new Texture(gl, width, height, 'r8')
    const selShape = new Texture(gl, width, height, 'r8')
    const selFbo = new Fbo(gl, selCur)
    const styleA = new Texture(gl, width, height, 'r8')
    const styleB = new Texture(gl, width, height, 'r8')
    const styleColor = new Texture(gl, width, height)

    this.doc = {
      width,
      height,
      layers: [],
      activeLayerId: null,
      accumA,
      accumB,
      scratch,
      strokeTex,
      strokeFbo,
      attachFbo,
      composite: accumA.texture,
      selCur,
      selScratch,
      selShape,
      selFbo,
      selActive: false,
      styleA,
      styleB,
      styleColor,
      blurA: null,
      blurB: null,
      blurSmall: new Map(),
    }
    const bg = this.createRasterRuntime('Фон')
    this.doc.layers.push(bg)
    this.doc.activeLayerId = bg.json.id
    if (background === 'white') this.fillTexture(bg.texture, [1, 1, 1, 1])

    this.maskEditLayerId = null
    this.history.clear()
    this.invalidate()
    this.emit()
  }

  /**
   * Изменение размера холста без потери слоёв. (dx, dy) — куда попадает
   * левый верх старого холста в новом (кадрирование = отрицательные).
   * Smart- и текстовые слои перерисовываются из оригинала — их содержимое
   * за старым краем «возвращается». Выделение снимается.
   */
  resizeCanvas(
    width: number,
    height: number,
    dx: number,
    dy: number,
    label = 'history.resizeCanvas',
  ): void {
    const doc = this.requireDoc()
    width = Math.round(width)
    height = Math.round(height)
    dx = Math.round(dx)
    dy = Math.round(dy)
    if (this.stroke || width < 1 || height < 1) return
    if (width > CANVAS_LIMITS.max || height > CANVAS_LIMITS.max) return
    if (width === doc.width && height === doc.height && dx === 0 && dy === 0) return
    if (this.floating) this.commitFloating()

    const gl = this.ctx.gl
    const oldW = doc.width
    const oldH = doc.height

    // Пары текстур каждого слоя: старые живут в замыкании истории для undo.
    const swaps = doc.layers.map((layer) => {
      // Текст и smart перерисовываются из оригинала — пиксели не переносим.
      const isRerendered =
        layer.json.kind === 'text' || (layer.json.kind === 'raster' && !!layer.json.smart)
      const newTex = new Texture(gl, width, height)
      if (!isRerendered) this.blitOffset(newTex, layer.texture, dx, dy, false)
      let newMask: Texture | null = null
      if (layer.mask) {
        newMask = new Texture(gl, width, height, 'r8')
        // Новая область маски — белая (видимая).
        this.blitOffset(newMask, layer.mask, dx, dy, true)
      }
      return { layer, oldTex: layer.texture, newTex, oldMask: layer.mask, newMask }
    })

    const apply = (w: number, h: number, sdx: number, sdy: number, use: 'new' | 'old'): void => {
      this.reallocDocBuffers(w, h)
      for (const s of swaps) {
        s.layer.texture = use === 'new' ? s.newTex : s.oldTex
        s.layer.mask = use === 'new' ? s.newMask : s.oldMask
        s.layer.blurTex?.dispose()
        s.layer.blurTex = null
        s.layer.blurKey = undefined
        const l = s.layer
        if (l.json.kind === 'text') {
          l.json.text.x += sdx
          l.json.text.y += sdy
          this.rasterizeTextLayer(l)
        } else if (l.json.kind === 'raster' && l.json.smart) {
          l.json.smart.transform.dx += sdx
          l.json.smart.transform.dy += sdy
          this.renderSmart(l)
        }
        this.touch(l)
      }
      this.invalidate()
    }

    apply(width, height, dx, dy, 'new')
    const bytes = swaps.reduce(
      (n, s) =>
        n + s.oldTex.bytes + s.newTex.bytes + (s.oldMask?.bytes ?? 0) + (s.newMask?.bytes ?? 0),
      0,
    )
    this.history.push({
      label,
      redo: () => apply(width, height, dx, dy, 'new'),
      undo: () => apply(oldW, oldH, -dx, -dy, 'old'),
      bytes,
      dispose: () => {
        for (const s of swaps) {
          if (s.layer.texture !== s.oldTex) s.oldTex.dispose()
          if (s.layer.texture !== s.newTex) s.newTex.dispose()
          if (s.oldMask && s.layer.mask !== s.oldMask) s.oldMask.dispose()
          if (s.newMask && s.layer.mask !== s.newMask) s.newMask.dispose()
        }
      },
    })
    this.emit()
  }

  getDocumentJson(): DocumentJson | null {
    if (!this.doc) return null
    return {
      schema: 1,
      width: this.doc.width,
      height: this.doc.height,
      layers: this.doc.layers.map((l) => structuredClone(l.json)),
      activeLayerId: this.doc.activeLayerId,
    }
  }

  // ───────────────────────── Слои ─────────────────────────

  addLayer(name: string): string {
    const runtime = this.createRasterRuntime(name)
    const index = this.activeIndex() + 1
    this.pushInsertLayerCommand(runtime, index, 'history.addLayer')
    return runtime.json.id
  }

  addTextLayer(name: string, params: TextParams): string {
    const doc = this.requireDoc()
    const runtime: LayerRuntime = {
      json: {
        kind: 'text',
        id: newLayerId(),
        name,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        clipped: false,
        hasMask: false,
        text: structuredClone(params),
      },
      texture: new Texture(this.ctx.gl, doc.width, doc.height),
      mask: null,
      source: null,
      version: 0,
    }
    this.rasterizeTextLayer(runtime)
    const index = this.activeIndex() + 1
    this.pushInsertLayerCommand(runtime, index, 'history.addTextLayer')
    return runtime.json.id
  }

  setTextParams(id: string, patch: Partial<TextParams>, options: { history?: boolean } = {}): void {
    const layer = this.findLayer(id)
    if (!layer || layer.json.kind !== 'text') return
    const before = structuredClone(layer.json.text)
    const after = { ...before, ...patch }
    // Правка текста сдвигает границы стилизованных фрагментов вместе с символами.
    if (patch.content !== undefined && patch.styleRanges === undefined && before.styleRanges?.length) {
      after.styleRanges = adjustStyleRanges(before.styleRanges, before.content, patch.content)
    }

    const apply = (params: TextParams) => {
      if (layer.json.kind !== 'text') return
      layer.json.text = structuredClone(params)
      this.rasterizeTextLayer(layer)
      this.invalidate()
    }
    apply(after)
    if (options.history !== false) {
      this.history.push({
        label: 'history.textEdit',
        redo: () => apply(after),
        undo: () => apply(before),
        bytes: 1024,
      })
    }
    this.emit()
  }

  deleteLayer(id: string): void {
    const doc = this.requireDoc()
    if (doc.layers.length <= 1) return
    const index = doc.layers.findIndex((l) => l.json.id === id)
    if (index < 0) return
    const runtime = doc.layers[index]!

    const remove = () => {
      const i = doc.layers.findIndex((l) => l.json.id === id)
      if (i >= 0) doc.layers.splice(i, 1)
      if (doc.activeLayerId === id) {
        doc.activeLayerId = doc.layers[Math.min(i, doc.layers.length - 1)]?.json.id ?? null
      }
      if (this.maskEditLayerId === id) this.maskEditLayerId = null
      this.invalidate()
    }
    const restore = () => {
      doc.layers.splice(index, 0, runtime)
      doc.activeLayerId = id
      this.invalidate()
    }
    remove()
    this.history.push({
      label: 'history.deleteLayer',
      redo: remove,
      undo: restore,
      bytes: runtime.texture.bytes + (runtime.mask?.bytes ?? 0),
      dispose: () => {
        if (!doc.layers.includes(runtime)) {
          runtime.texture.dispose()
          runtime.mask?.dispose()
          runtime.source?.dispose()
          runtime.blurTex?.dispose()
        }
      },
    })
    this.emit()
  }

  setLayerProps(
    id: string,
    patch: Partial<Pick<LayerJson, 'name' | 'visible' | 'opacity' | 'blendMode' | 'clipped'>>,
    options: { history?: boolean } = {},
  ): void {
    const layer = this.findLayer(id)
    if (!layer) return
    const before = structuredClone(layer.json)
    const after = { ...structuredClone(layer.json), ...patch } as LayerJson

    const apply = (json: LayerJson) => {
      layer.json = structuredClone(json)
      this.invalidate()
    }
    apply(after)
    if (options.history !== false) {
      this.history.push({
        label: 'history.layerProps',
        redo: () => apply(after),
        undo: () => apply(before),
        bytes: 512,
      })
    }
    this.emit()
  }

  moveLayer(id: string, toIndex: number): void {
    const doc = this.requireDoc()
    const from = doc.layers.findIndex((l) => l.json.id === id)
    const to = Math.max(0, Math.min(doc.layers.length - 1, toIndex))
    if (from < 0 || from === to) return

    const move = (a: number, b: number) => {
      const [item] = doc.layers.splice(a, 1)
      doc.layers.splice(b, 0, item!)
      this.invalidate()
    }
    move(from, to)
    this.history.push({
      label: 'history.moveLayer',
      redo: () => move(from, to),
      undo: () => move(to, from),
      bytes: 128,
    })
    this.emit()
  }

  setActiveLayer(id: string): void {
    const doc = this.requireDoc()
    if (doc.layers.some((l) => l.json.id === id)) {
      doc.activeLayerId = id
      if (this.maskEditLayerId && this.maskEditLayerId !== id) this.maskEditLayerId = null
      this.emit()
    }
  }

  /** Стили слоя (тени) — отдельная команда истории. */
  setLayerStyles(id: string, styles: LayerStyles | undefined, options: { history?: boolean } = {}): void {
    const layer = this.findLayer(id)
    if (!layer) return
    const before = structuredClone(layer.json.styles)
    const after = structuredClone(styles)

    const apply = (s: LayerStyles | undefined) => {
      if (s === undefined) delete layer.json.styles
      else layer.json.styles = structuredClone(s)
      this.invalidate()
    }
    apply(after)
    if (options.history !== false) {
      this.history.push({
        label: 'history.layerStyles',
        redo: () => apply(after),
        undo: () => apply(before),
        bytes: 512,
      })
    }
    this.emit()
  }

  /** Сведение всех слоёв в один (Flatten). */
  flattenImage(): void {
    const doc = this.requireDoc()
    if (this.compositeDirty) this.compose()

    const gl = this.ctx.gl
    const flat: LayerRuntime = {
      json: {
        kind: 'raster',
        id: newLayerId(),
        name: 'Сведённый слой',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        clipped: false,
        hasMask: false,
      },
      texture: new Texture(gl, doc.width, doc.height),
      mask: null,
      source: null,
      version: 0,
    }
    this.copyTexture(doc.composite, flat.texture)

    const oldLayers = doc.layers
    const oldActive = doc.activeLayerId
    const apply = () => {
      doc.layers = [flat]
      doc.activeLayerId = flat.json.id
      this.maskEditLayerId = null
      this.invalidate()
    }
    const revert = () => {
      doc.layers = oldLayers
      doc.activeLayerId = oldActive
      this.invalidate()
    }
    apply()
    this.history.push({
      label: 'history.flatten',
      redo: apply,
      undo: revert,
      bytes: oldLayers.reduce((s, l) => s + l.texture.bytes + (l.mask?.bytes ?? 0), 0),
      dispose: () => {
        // При вытеснении из истории старые слои уже не вернуть — чистим GPU.
        if (doc.layers.length === 1 && doc.layers[0] === flat) {
          for (const l of oldLayers) {
            l.texture.dispose()
            l.mask?.dispose()
            l.source?.dispose()
            l.blurTex?.dispose()
          }
        } else {
          flat.texture.dispose()
        }
      },
    })
    this.emit()
  }

  /** Заливка выделения (или всего слоя, если выделения нет) цветом. */
  fillSelectedArea(color: RgbaColor): void {
    const doc = this.requireDoc()
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer || layer.json.kind !== 'raster') return
    if (layer.json.smart) this.rasterizeSmartLayer(layer.json.id)

    const useSel = doc.selActive
    doc.attachFbo.attach(layer.texture)
    const before = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )

    if (useSel) {
      // merge: color поверх слоя с coverage = маска выделения.
      const gl = this.ctx.gl
      doc.scratch.bind()
      gl.disable(gl.BLEND)
      this.progMerge.use()
      layer.texture.bind(0)
      doc.selCur.bind(1)
      this.progMerge.setInt('uLayer', 0)
      this.progMerge.setInt('uStroke', 1)
      const [r, g, b, a] = color
      this.progMerge.setVec4('uColor', r, g, b, a)
      this.progMerge.setFloat('uOpacity', 1)
      this.progMerge.setInt('uErase', 0)
      this.progMerge.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      const tmp = layer.texture
      layer.texture = doc.scratch.texture
      doc.scratch.attach(tmp)
    } else {
      this.fillTexture(layer.texture, color)
    }

    doc.attachFbo.attach(layer.texture)
    const after = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    const engine = this
    const layerId = layer.json.id
    this.touch(layer)
    this.history.push({
      label: 'history.fill',
      bytes: before.bytes + after.bytes,
      undo: () => engine.uploadPatch(layerId, 'pixels', before),
      redo: () => engine.uploadPatch(layerId, 'pixels', after),
    })
    this.invalidate()
    this.emit()
  }

  /** Удаление содержимого выделения на активном слое (Del). */
  clearSelectedArea(): void {
    const doc = this.requireDoc()
    if (!doc.selActive) return
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer || layer.json.kind !== 'raster') return
    if (layer.json.smart) this.rasterizeSmartLayer(layer.json.id)

    doc.attachFbo.attach(layer.texture)
    const before = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )

    // out = layer * (1 - sel): merge-шейдер в режиме ластика с coverage = selCur.
    const gl = this.ctx.gl
    doc.scratch.bind()
    gl.disable(gl.BLEND)
    this.progMerge.use()
    layer.texture.bind(0)
    doc.selCur.bind(1)
    this.progMerge.setInt('uLayer', 0)
    this.progMerge.setInt('uStroke', 1)
    this.progMerge.setVec4('uColor', 0, 0, 0, 1)
    this.progMerge.setFloat('uOpacity', 1)
    this.progMerge.setInt('uErase', 1)
    this.progMerge.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    const tmp = layer.texture
    layer.texture = doc.scratch.texture
    doc.scratch.attach(tmp)

    doc.attachFbo.attach(layer.texture)
    const after = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    const engine = this
    const layerId = layer.json.id
    this.touch(layer)
    this.history.push({
      label: 'history.clear',
      bytes: before.bytes + after.bytes,
      undo: () => engine.uploadPatch(layerId, 'pixels', before),
      redo: () => engine.uploadPatch(layerId, 'pixels', after),
    })
    this.invalidate()
    this.emit()
  }

  /** Метки истории для панели истории. */
  getHistoryLabels(): { undo: string[]; redo: string[] } {
    return { undo: this.history.allUndoLabels(), redo: this.history.allRedoLabels() }
  }

  // ───────────────────────── Маски слоя ─────────────────────────

  addLayerMask(id: string, fromSelection: boolean): void {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer || layer.mask) return

    const mask = new Texture(this.ctx.gl, doc.width, doc.height, 'r8')
    if (fromSelection && doc.selActive) {
      this.copyTexture(doc.selCur, mask)
    } else {
      doc.attachFbo.attach(mask)
      doc.attachFbo.clear(1, 0, 0, 1)
    }

    const add = () => {
      layer.mask = mask
      layer.json.hasMask = true
      this.invalidate()
    }
    const remove = () => {
      layer.mask = null
      layer.json.hasMask = false
      if (this.maskEditLayerId === id) this.maskEditLayerId = null
      this.invalidate()
    }
    add()
    this.history.push({
      label: 'history.addMask',
      redo: add,
      undo: remove,
      bytes: mask.bytes,
      dispose: () => {
        if (layer.mask !== mask) mask.dispose()
      },
    })
    this.emit()
  }

  removeLayerMask(id: string): void {
    const layer = this.findLayer(id)
    const mask = layer?.mask
    if (!layer || !mask) return

    const remove = () => {
      layer.mask = null
      layer.json.hasMask = false
      if (this.maskEditLayerId === id) this.maskEditLayerId = null
      this.invalidate()
    }
    const restore = () => {
      layer.mask = mask
      layer.json.hasMask = true
      this.invalidate()
    }
    remove()
    this.history.push({
      label: 'history.removeMask',
      redo: remove,
      undo: restore,
      bytes: mask.bytes,
      dispose: () => {
        if (layer.mask !== mask) mask.dispose()
      },
    })
    this.emit()
  }

  /** Включает/выключает режим рисования по маске слоя. */
  setMaskEditing(layerId: string | null): void {
    this.maskEditLayerId = layerId
    this.emit()
  }

  // ───────────────────────── Выделение ─────────────────────────

  selectRect(x: number, y: number, w: number, h: number, op: SelectionOp): void {
    const doc = this.requireDoc()
    this.applySelectionChange('history.select', () => {
      this.combineShape(rasterRect(doc.width, doc.height, x, y, w, h), op)
    })
  }

  selectEllipse(cx: number, cy: number, rx: number, ry: number, op: SelectionOp): void {
    const doc = this.requireDoc()
    this.applySelectionChange('history.select', () => {
      this.combineShape(rasterEllipse(doc.width, doc.height, cx, cy, rx, ry), op)
    })
  }

  selectPolygon(points: Point[], op: SelectionOp): void {
    const doc = this.requireDoc()
    this.applySelectionChange('history.select', () => {
      this.combineShape(rasterPolygon(doc.width, doc.height, points), op)
    })
  }

  selectWand(x: number, y: number, tolerance: number, op: SelectionOp): void {
    const doc = this.requireDoc()
    const comp = this.readComposite()
    this.applySelectionChange('history.select', () => {
      this.combineShape(magicWand(comp.pixels, doc.width, doc.height, x, y, tolerance), op)
    })
  }

  /** Текущая маска выделения (R8) — для AI-операций над областью. */
  readSelectionMask(): { mask: Uint8Array; active: boolean } {
    const doc = this.requireDoc()
    doc.attachFbo.attach(doc.selCur)
    return {
      mask: doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
      active: doc.selActive,
    }
  }

  /** Выделение из готовой R8-маски (SAM и другие внешние источники). */
  selectFromMask(mask: Uint8Array, op: SelectionOp, label = 'history.samSelect'): void {
    const doc = this.requireDoc()
    if (mask.length !== doc.width * doc.height) {
      throw new Error('Размер маски не совпадает с документом')
    }
    this.applySelectionChange(label, () => {
      this.combineShape(mask, op)
    })
  }

  selectAll(): void {
    const doc = this.requireDoc()
    this.applySelectionChange('history.select', () => {
      doc.selFbo.attach(doc.selCur)
      doc.selFbo.clear(1, 0, 0, 1)
      doc.selActive = true
    })
  }

  deselect(): void {
    const doc = this.requireDoc()
    if (!doc.selActive) return
    this.applySelectionChange('history.deselect', () => {
      doc.selFbo.attach(doc.selCur)
      doc.selFbo.clear(0, 0, 0, 1)
      doc.selActive = false
    })
  }

  invertSelection(): void {
    const doc = this.requireDoc()
    if (!doc.selActive) return
    this.applySelectionChange('history.invertSelection', () => {
      doc.selFbo.attach(doc.selScratch)
      doc.selFbo.bind()
      this.ctx.gl.disable(this.ctx.gl.BLEND)
      this.progInvert.use()
      doc.selCur.bind(0)
      this.progInvert.setInt('uTex', 0)
      this.progInvert.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      this.swapSel()
    })
  }

  featherSelection(radius: number): void {
    const doc = this.requireDoc()
    if (!doc.selActive || radius <= 0) return
    const r = Math.min(100, Math.round(radius))
    this.applySelectionChange('history.feather', () => {
      const gl = this.ctx.gl
      gl.disable(gl.BLEND)
      // Горизонтальный проход: selCur → selScratch.
      doc.selFbo.attach(doc.selScratch)
      doc.selFbo.bind()
      this.progGauss.use()
      doc.selCur.bind(0)
      this.progGauss.setInt('uTex', 0)
      this.progGauss.setInt('uRadius', r)
      this.progGauss.setVec2('uDir', 1 / doc.width, 0)
      this.progGauss.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      this.swapSel()
      // Вертикальный проход.
      doc.selFbo.attach(doc.selScratch)
      doc.selFbo.bind()
      doc.selCur.bind(0)
      this.progGauss.setVec2('uDir', 0, 1 / doc.height)
      this.quad.draw()
      this.swapSel()
    })
  }

  // ───────────────────────── Floating (перемещение/трансформация) ─────────────────────────

  get floatingState(): FloatingState | null {
    if (!this.floating) return null
    const { layerId, bbox, cx, cy, dx, dy, sx, sy, rot } = this.floating
    return { layerId, bbox: { ...bbox }, cx, cy, dx, dy, sx, sy, rot }
  }

  /**
   * «Поднимает» выделенную область активного слоя в плавающий фрагмент:
   * пиксели вырезаются из слоя и дальше двигаются/трансформируются без потерь
   * до commitFloating(). Возвращает false, если поднимать нечего.
   */
  liftSelection(): boolean {
    const doc = this.requireDoc()
    if (this.floating || this.stroke) return false
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer || layer.json.kind !== 'raster') return false
    // Smart-слой трансформируется своим механизмом (без потерь) — lift
    // только по явному выделению (вырезание куска растеризует слой).
    if (layer.json.smart) {
      if (!doc.selActive) return false
      this.rasterizeSmartLayer(layer.json.id)
    }
    const wasSelActive = doc.selActive

    // Без выделения — трансформируется всё содержимое слоя (по альфе),
    // как Ctrl+T в Photoshop.
    if (!doc.selActive) {
      const gl0 = this.ctx.gl
      doc.selFbo.attach(doc.selCur)
      doc.selFbo.bind()
      gl0.disable(gl0.BLEND)
      this.progShadowMask.use()
      layer.texture.bind(0)
      this.progShadowMask.setInt('uSrc', 0)
      this.progShadowMask.setInt('uUseMask', 0)
      this.progShadowMask.setVec2('uOffset', 0, 0)
      this.progShadowMask.setInt('uInvert', 0)
      this.progShadowMask.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      doc.selActive = true
    }

    // Бэкапы для undo/cancel.
    doc.attachFbo.attach(layer.texture)
    const backupLayer = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    doc.attachFbo.attach(doc.selCur)
    const selPixels = doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
    const backupSel = new PixelPatch({ x: 0, y: 0, w: doc.width, h: doc.height }, selPixels)

    const bbox = maskBounds(selPixels, doc.width, doc.height)
    if (!bbox) return false

    const gl = this.ctx.gl
    // Вырезанные пиксели: layer × sel.
    const tex = new Texture(gl, doc.width, doc.height)
    doc.attachFbo.attach(tex)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    this.progExtract.use()
    layer.texture.bind(0)
    doc.selCur.bind(1)
    this.progExtract.setInt('uLayer', 0)
    this.progExtract.setInt('uSel', 1)
    this.progExtract.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()

    // Копия маски (для трансформации выделения при коммите).
    const selTex = new Texture(gl, doc.width, doc.height, 'r8')
    this.copyTexture(doc.selCur, selTex)

    // Вырезать из слоя: layer × (1−sel).
    doc.scratch.bind()
    this.progMerge.use()
    layer.texture.bind(0)
    doc.selCur.bind(1)
    this.progMerge.setInt('uLayer', 0)
    this.progMerge.setInt('uStroke', 1)
    this.progMerge.setVec4('uColor', 0, 0, 0, 1)
    this.progMerge.setFloat('uOpacity', 1)
    this.progMerge.setInt('uErase', 1)
    this.progMerge.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    const tmp = layer.texture
    layer.texture = doc.scratch.texture
    doc.scratch.attach(tmp)
    this.touch(layer)

    this.floating = {
      layerId: layer.json.id,
      bbox,
      cx: bbox.x + bbox.w / 2,
      cy: bbox.y + bbox.h / 2,
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
      rot: 0,
      tex,
      selTex,
      backupLayer,
      backupSel,
      wasSelActive,
    }
    this.invalidate()
    this.emit()
    return true
  }

  setFloatingTransform(patch: Partial<Pick<FloatingState, 'dx' | 'dy' | 'sx' | 'sy' | 'rot'>>): void {
    if (!this.floating) return
    Object.assign(this.floating, patch)
    this.invalidate()
  }

  /** Прижигает плавающий фрагмент обратно в слой (одна запись истории). */
  commitFloating(): void {
    const doc = this.doc
    const f = this.floating
    if (!doc || !f) return
    const layer = this.findLayer(f.layerId)
    this.floating = null
    if (!layer) {
      f.tex.dispose()
      f.selTex.dispose()
      return
    }

    const gl = this.ctx.gl
    // layer + floating(transform) → scratch → swap.
    doc.scratch.bind()
    gl.disable(gl.BLEND)
    this.progCopy.use()
    layer.texture.bind(0)
    this.progCopy.setInt('uTex', 0)
    this.progCopy.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.drawFloating(f, f.tex)
    gl.disable(gl.BLEND)
    const tmp = layer.texture
    layer.texture = doc.scratch.texture
    doc.scratch.attach(tmp)
    this.touch(layer)

    // Маска выделения перемещается вместе с фрагментом.
    doc.selFbo.attach(doc.selCur)
    doc.selFbo.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.drawFloating(f, f.selTex)

    doc.attachFbo.attach(layer.texture)
    const afterLayer = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    doc.attachFbo.attach(doc.selCur)
    const afterSel = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )

    const engine = this
    const layerId = f.layerId
    const { backupLayer, backupSel } = f
    this.history.push({
      label: 'history.transform',
      bytes: backupLayer.bytes + backupSel.bytes + afterLayer.bytes + afterSel.bytes,
      undo: () => {
        engine.uploadPatch(layerId, 'pixels', backupLayer)
        engine.restoreSelection(backupSel, f.wasSelActive)
      },
      redo: () => {
        engine.uploadPatch(layerId, 'pixels', afterLayer)
        engine.restoreSelection(afterSel, true)
      },
    })

    f.tex.dispose()
    f.selTex.dispose()
    this.invalidate()
    this.emit()
  }

  /** Delete во время трансформации: фрагмент удаляется насовсем. */
  deleteFloating(): void {
    const doc = this.doc
    const f = this.floating
    if (!doc || !f) return
    this.floating = null
    const layer = this.findLayer(f.layerId)
    if (!layer) {
      f.tex.dispose()
      f.selTex.dispose()
      return
    }
    // Пиксели уже вырезаны из слоя при lift — фиксируем это как удаление.
    doc.attachFbo.attach(layer.texture)
    const after = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    const engine = this
    const layerId = f.layerId
    const { backupLayer, backupSel, wasSelActive } = f
    this.history.push({
      label: 'history.clear',
      bytes: backupLayer.bytes + after.bytes,
      undo: () => {
        engine.uploadPatch(layerId, 'pixels', backupLayer)
        engine.restoreSelection(backupSel, wasSelActive)
      },
      redo: () => engine.uploadPatch(layerId, 'pixels', after),
    })
    f.tex.dispose()
    f.selTex.dispose()
    this.touch(layer)
    this.invalidate()
    this.emit()
  }

  /** Отменяет плавающий фрагмент: слой и выделение как до lift. */
  cancelFloating(): void {
    const f = this.floating
    if (!f) return
    this.floating = null
    const layer = this.findLayer(f.layerId)
    if (layer) {
      const { rect } = f.backupLayer
      layer.texture.upload(f.backupLayer.unpack(), rect.x, rect.y, rect.w, rect.h)
      this.touch(layer)
    }
    this.restoreSelection(f.backupSel, f.wasSelActive)
    f.tex.dispose()
    f.selTex.dispose()
    this.invalidate()
    this.emit()
  }

  get hasFloating(): boolean {
    return this.floating !== null
  }

  /** Ctrl+J: копия выделенного (или всего слоя) новым слоем. */
  copySelectionToLayer(): string | null {
    const doc = this.requireDoc()
    const src = this.findLayer(doc.activeLayerId ?? '')
    if (!src) return null

    const runtime = this.createRasterRuntime(`${src.json.name} (копия)`)
    const gl = this.ctx.gl
    doc.attachFbo.attach(runtime.texture)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    if (doc.selActive) {
      this.progExtract.use()
      src.texture.bind(0)
      doc.selCur.bind(1)
      this.progExtract.setInt('uLayer', 0)
      this.progExtract.setInt('uSel', 1)
      this.progExtract.setVec4('uRect', ...FULL_RECT)
    } else {
      this.progCopy.use()
      src.texture.bind(0)
      this.progCopy.setInt('uTex', 0)
      this.progCopy.setVec4('uRect', ...FULL_RECT)
    }
    this.quad.draw()
    this.touch(runtime)
    this.pushInsertLayerCommand(runtime, this.activeIndex() + 1, 'history.copyLayer')
    return runtime.json.id
  }

  /** Дубликат слоя (с маской). */
  duplicateLayer(id: string): string | null {
    const doc = this.requireDoc()
    const src = this.findLayer(id)
    if (!src) return null
    const gl = this.ctx.gl

    const runtime: LayerRuntime = {
      json: { ...structuredClone(src.json), id: newLayerId(), name: `${src.json.name} (копия)` },
      texture: new Texture(gl, doc.width, doc.height),
      mask: null,
      source: null,
      version: 0,
    }
    this.copyTexture(src.texture, runtime.texture)
    this.touch(runtime)
    if (src.mask) {
      runtime.mask = new Texture(gl, doc.width, doc.height, 'r8')
      this.copyTexture(src.mask, runtime.mask)
    }
    if (src.source && src.json.kind === 'raster' && src.json.smart) {
      runtime.source = new Texture(gl, src.json.smart.srcW, src.json.smart.srcH)
      this.copyTexture(src.source, runtime.source)
    }
    const index = doc.layers.findIndex((l) => l.json.id === id) + 1
    this.pushInsertLayerCommand(runtime, index, 'history.duplicateLayer')
    return runtime.json.id
  }

  /**
   * Объединение слоёв в один (Merge Selected / Merge Visible / Merge Down).
   * Композит подмножества считается штатным конвейером (маски и стили
   * вжигаются), результат встаёт на позицию верхнего из объединяемых.
   */
  mergeLayers(ids: string[], name = 'Объединённый слой'): string | null {
    const doc = this.requireDoc()
    const targets = doc.layers.filter((l) => ids.includes(l.json.id))
    if (targets.length < 2) return null

    // Композит только выбранных: временно прячем остальные и переиспользуем compose().
    const hidden: LayerRuntime[] = []
    for (const l of doc.layers) {
      if (!ids.includes(l.json.id) && l.json.visible) {
        l.json.visible = false
        hidden.push(l)
      }
    }
    this.compositeDirty = true
    this.compose()
    const merged = this.createRasterRuntime(name)
    this.copyTexture(doc.composite, merged.texture)
    this.touch(merged)
    for (const l of hidden) l.json.visible = true
    this.compositeDirty = true

    const oldLayers = [...doc.layers]
    const oldActive = doc.activeLayerId
    const topIndex = Math.max(...targets.map((t) => doc.layers.indexOf(t)))
    const newLayers = doc.layers.filter((l) => !ids.includes(l.json.id))
    // Позиция: перед слоем, который шёл после верхнего объединяемого.
    const after = doc.layers.slice(topIndex + 1).find((l) => !ids.includes(l.json.id))
    const insertAt = after ? newLayers.indexOf(after) : newLayers.length
    newLayers.splice(insertAt, 0, merged)

    const apply = () => {
      doc.layers = newLayers
      doc.activeLayerId = merged.json.id
      this.maskEditLayerId = null
      this.invalidate()
    }
    const revert = () => {
      doc.layers = oldLayers
      doc.activeLayerId = oldActive
      this.invalidate()
    }
    apply()
    this.history.push({
      label: 'history.mergeLayers',
      redo: apply,
      undo: revert,
      bytes: targets.reduce((s, l) => s + l.texture.bytes + (l.mask?.bytes ?? 0), 0),
      dispose: () => {
        if (doc.layers === newLayers || doc.layers.includes(merged)) {
          for (const l of targets) {
            l.texture.dispose()
            l.mask?.dispose()
            l.source?.dispose()
            l.blurTex?.dispose()
          }
        } else {
          merged.texture.dispose()
        }
      },
    })
    this.emit()
    return merged.json.id
  }

  /**
   * Выделение по альфе слоя (Ctrl+A / Ctrl+клик по миниатюре).
   * Если слой полностью пуст — выделяется весь холст.
   */
  selectFromLayerAlpha(id: string): void {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer) return
    this.applySelectionChange('history.select', () => {
      const gl = this.ctx.gl
      doc.selFbo.attach(doc.selScratch)
      doc.selFbo.bind()
      gl.disable(gl.BLEND)
      // Альфа слоя (с учётом маски) через shadow-mask шейдер без смещения.
      this.progShadowMask.use()
      layer.texture.bind(0)
      this.progShadowMask.setInt('uSrc', 0)
      if (layer.mask) {
        layer.mask.bind(1)
        this.progShadowMask.setInt('uMask', 1)
      }
      this.progShadowMask.setInt('uUseMask', layer.mask ? 1 : 0)
      this.progShadowMask.setVec2('uOffset', 0, 0)
      this.progShadowMask.setInt('uInvert', 0)
      this.progShadowMask.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      this.swapSel()
      // Пустой слой → нечего обводить: выделяем весь холст (как PS Ctrl+A).
      doc.attachFbo.attach(doc.selCur)
      const mask = doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
      if (!maskBounds(mask, doc.width, doc.height)) {
        doc.selFbo.attach(doc.selCur)
        doc.selFbo.clear(1, 0, 0, 1)
      }
      doc.selActive = true
    })
  }

  /** Копия выделенной области активного слоя (для внутреннего буфера обмена). */
  copySelectedPixels(): { pixels: Uint8Array; width: number; height: number } | null {
    const doc = this.requireDoc()
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer) return null
    const gl = this.ctx.gl
    const tex = new Texture(gl, doc.width, doc.height)
    doc.attachFbo.attach(tex)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    if (doc.selActive) {
      this.progExtract.use()
      layer.texture.bind(0)
      doc.selCur.bind(1)
      this.progExtract.setInt('uLayer', 0)
      this.progExtract.setInt('uSel', 1)
      this.progExtract.setVec4('uRect', ...FULL_RECT)
    } else {
      this.progCopy.use()
      layer.texture.bind(0)
      this.progCopy.setInt('uTex', 0)
      this.progCopy.setVec4('uRect', ...FULL_RECT)
    }
    this.quad.draw()
    const pixels = doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
    tex.dispose()
    return { pixels, width: doc.width, height: doc.height }
  }

  /** Вставка из внутреннего буфера — всегда новым слоем (как в Photoshop). */
  pasteAsLayer(
    pixels: Uint8Array,
    width: number,
    height: number,
    name = 'Вставлено',
    styles?: LayerStyles,
  ): string | null {
    const doc = this.requireDoc()
    const runtime = this.createRasterRuntime(name)
    if (styles) runtime.json.styles = structuredClone(styles)
    if (width === doc.width && height === doc.height) {
      runtime.texture.upload(pixels, 0, 0, width, height)
    } else {
      // Буфер от документа другого размера — кладём в левый верхний угол.
      const w = Math.min(width, doc.width)
      const h = Math.min(height, doc.height)
      const cropped = new Uint8Array(w * h * 4)
      for (let y = 0; y < h; y++) {
        cropped.set(pixels.subarray(y * width * 4, y * width * 4 + w * 4), y * w * 4)
      }
      runtime.texture.upload(cropped, 0, 0, w, h)
    }
    this.touch(runtime)
    this.pushInsertLayerCommand(runtime, this.activeIndex() + 1, 'history.paste')
    return runtime.json.id
  }

  /** Миниатюра слоя: GPU-даунскейл, дешёвый readback. */
  getLayerThumbnail(id: string, maxSize = 40): { pixels: Uint8Array; w: number; h: number } | null {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer) return null
    const k = Math.min(maxSize / doc.width, maxSize / doc.height)
    const w = Math.max(1, Math.round(doc.width * k))
    const h = Math.max(1, Math.round(doc.height * k))

    const gl = this.ctx.gl
    const tex = new Texture(gl, w, h)
    doc.attachFbo.attach(tex)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    this.progCopy.use()
    layer.texture.bind(0)
    this.progCopy.setInt('uTex', 0)
    this.progCopy.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    const pixels = doc.attachFbo.readPixels(0, 0, w, h)
    tex.dispose()
    return { pixels, w, h }
  }

  getLayerVersions(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const l of this.doc?.layers ?? []) out[l.json.id] = l.version
    return out
  }

  /** Отрисовка floating-текстуры в текущий FBO с аффинной трансформацией. */
  private drawFloating(f: FloatingRuntime, tex: Texture): void {
    const doc = this.requireDoc()
    this.progFloat.use()
    tex.bind(0)
    this.progFloat.setInt('uTex', 0)
    this.progFloat.setVec2('uDocSize', doc.width, doc.height)
    this.progFloat.setVec2('uCenter', f.cx, f.cy)
    this.progFloat.setVec2('uDelta', f.dx, f.dy)
    this.progFloat.setVec2('uScale', f.sx, f.sy)
    this.progFloat.setFloat('uRot', f.rot)
    this.progFloat.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
  }

  // ───────────────────────── Штрих ─────────────────────────

  beginStroke(mode: 'brush' | 'erase', brush: BrushParams, color: RgbaColor, p: StrokePoint): void {
    const doc = this.requireDoc()
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer || !layer.json.visible) return

    const editingMask = this.maskEditLayerId === layer.json.id && layer.mask !== null
    // Рисование по smart-слою растеризует его (как в Photoshop).
    if (!editingMask && layer.json.kind === 'raster' && layer.json.smart) {
      this.rasterizeSmartLayer(layer.json.id)
    }
    // По текстовому слою рисовать нельзя (только по его маске).
    if (layer.json.kind === 'text' && !editingMask) return

    doc.strokeFbo.clear()
    this.stroke = {
      layerId: layer.json.id,
      target: editingMask ? 'mask' : 'pixels',
      mode,
      brush,
      color,
      layout: new StrokeLayout(brush),
      dirty: null,
    }
    this.stampDabs(this.stroke.layout.start(p))
  }

  /** Кисть выделения: штрих добавляется к выделению или вычитается из него. */
  beginSelectionStroke(op: 'add' | 'subtract', brush: BrushParams, p: StrokePoint): void {
    const doc = this.requireDoc()
    doc.strokeFbo.clear()
    this.stroke = {
      layerId: '',
      target: 'selection',
      mode: 'brush',
      selOp: op,
      brush,
      color: [1, 1, 1, 1],
      layout: new StrokeLayout(brush),
      dirty: null,
    }
    this.stampDabs(this.stroke.layout.start(p))
  }

  strokeTo(p: StrokePoint): void {
    if (!this.stroke) return
    this.stampDabs(this.stroke.layout.extend(p))
  }

  endStroke(): void {
    const doc = this.doc
    const stroke = this.stroke
    this.stroke = null
    if (!doc || !stroke || !stroke.dirty) {
      this.invalidate()
      return
    }

    // Кисть выделения: скомбинировать штрих с маской выделения.
    if (stroke.target === 'selection') {
      this.applySelectionChange('history.select', () => {
        const gl = this.ctx.gl
        doc.selFbo.attach(doc.selScratch)
        doc.selFbo.bind()
        gl.disable(gl.BLEND)
        this.progSelCombine.use()
        doc.selCur.bind(0)
        doc.strokeTex.bind(1)
        this.progSelCombine.setInt('uA', 0)
        this.progSelCombine.setInt('uB', 1)
        this.progSelCombine.setInt('uOp', OP_INDEX[stroke.selOp ?? 'add'])
        this.progSelCombine.setVec4('uRect', ...FULL_RECT)
        this.quad.draw()
        this.swapSel()
        doc.selActive = true
      })
      this.invalidate()
      return
    }

    const layer = this.findLayer(stroke.layerId)
    if (!layer) return
    const target = stroke.target === 'mask' ? layer.mask : layer.texture
    if (!target) return

    const rect = this.clampRect(stroke.dirty)
    if (rect.w === 0 || rect.h === 0) {
      this.invalidate()
      return
    }

    doc.attachFbo.attach(target)
    const before = doc.attachFbo.readPixels(rect.x, rect.y, rect.w, rect.h)

    // Слить штрих: merge(target, stroke) → r8/rgba scratch, swap.
    if (stroke.target === 'mask') {
      this.mergeStrokeMask(target, stroke, doc.selScratch)
      const tmp = layer.mask!
      layer.mask = doc.selScratch
      doc.selScratch = tmp
    } else {
      this.mergeStroke(layer.texture, stroke, doc.scratch)
      const tmp = layer.texture
      layer.texture = doc.scratch.texture
      doc.scratch.attach(tmp)
    }

    this.touch(layer)
    const newTarget = stroke.target === 'mask' ? layer.mask! : layer.texture
    doc.attachFbo.attach(newTarget)
    const after = doc.attachFbo.readPixels(rect.x, rect.y, rect.w, rect.h)

    const beforePatch = new PixelPatch(rect, before)
    const afterPatch = new PixelPatch(rect, after)
    const engine = this
    const strokeTarget = stroke.target

    this.history.push({
      label: stroke.mode === 'erase' ? 'history.erase' : 'history.brushStroke',
      bytes: beforePatch.bytes + afterPatch.bytes,
      undo: () => engine.uploadPatch(stroke.layerId, strokeTarget, beforePatch),
      redo: () => engine.uploadPatch(stroke.layerId, strokeTarget, afterPatch),
    })
    this.invalidate()
    this.emit()
  }

  get isStroking(): boolean {
    return this.stroke !== null
  }

  undo(): void {
    this.history.undo()
    this.invalidate()
  }

  redo(): void {
    this.history.redo()
    this.invalidate()
  }

  // ───────────────────────── Вид ─────────────────────────

  resizeDisplay(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr
    const w = Math.max(1, Math.round(cssW * dpr))
    const h = Math.max(1, Math.round(cssH * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.invalidatePresent()
  }

  setView(view: Partial<View>): void {
    this.view = { ...this.view, ...view }
    this.invalidatePresent()
  }

  zoomAt(cssX: number, cssY: number, factor: number): void {
    const v = this.view
    const scale = Math.min(64, Math.max(1 / 64, v.scale * factor))
    const k = scale / v.scale
    this.setView({
      scale,
      panX: cssX - (cssX - v.panX) * k,
      panY: cssY - (cssY - v.panY) * k,
    })
  }

  zoomFit(viewportW: number, viewportH: number): void {
    const doc = this.doc
    if (!doc) return
    const margin = 48
    const scale = Math.min((viewportW - margin) / doc.width, (viewportH - margin) / doc.height, 1)
    this.setView({
      scale,
      panX: (viewportW - doc.width * scale) / 2,
      panY: (viewportH - doc.height * scale) / 2,
    })
  }

  viewToDoc(cssX: number, cssY: number): { x: number; y: number } {
    const v = this.view
    return { x: (cssX - v.panX) / v.scale, y: (cssY - v.panY) / v.scale }
  }

  // ───────────────────────── Рендер ─────────────────────────

  render(): void {
    if (!this.doc) return
    if (this.compositeDirty) this.compose()
    this.present()
    this.presentQueued = false
    this.lastRenderAt = performance.now()
  }

  private lastRenderAt = 0

  get needsRender(): boolean {
    if (this.compositeDirty || this.presentQueued) return true
    // Муравьи анимируются ~10 к/с: полные 60 fps в простое жгут GPU впустую.
    if (this.doc?.selActive) return performance.now() - this.lastRenderAt >= 100
    return false
  }

  // ───────────────────────── Кисти ─────────────────────────

  /** Регистрирует типс кисти (R8 coverage). Повторная регистрация заменяет. */
  registerBrushTip(id: string, coverage: Uint8Array, w: number, h: number): void {
    this.brushTips.get(id)?.dispose()
    const tex = new Texture(this.ctx.gl, w, h, 'r8')
    tex.upload(coverage, 0, 0, w, h)
    this.brushTips.set(id, tex)
  }

  hasBrushTip(id: string): boolean {
    return this.brushTips.has(id)
  }

  // ───────────────────────── Файловый IO ─────────────────────────

  /** Пиксели слоя (premultiplied RGBA, строка 0 — верх). */
  readLayerPixels(id: string): Uint8Array | null {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer) return null
    doc.attachFbo.attach(layer.texture)
    return doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
  }

  /** Оригинал smart-слоя (premultiplied RGBA размером srcW×srcH). */
  readSourcePixels(id: string): { pixels: Uint8Array; w: number; h: number } | null {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer?.source || layer.json.kind !== 'raster' || !layer.json.smart) return null
    doc.attachFbo.attach(layer.source)
    return {
      pixels: doc.attachFbo.readPixels(0, 0, layer.json.smart.srcW, layer.json.smart.srcH),
      w: layer.json.smart.srcW,
      h: layer.json.smart.srcH,
    }
  }

  /** Пиксели маски слоя (R8), если маска есть. */
  readMaskPixels(id: string): Uint8Array | null {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer?.mask) return null
    doc.attachFbo.attach(layer.mask)
    return doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
  }

  /**
   * Восстановление документа из сериализованного состояния (.slojka/ORA/PSD).
   * pixels: premultiplied RGBA послойно; mask: R8. Текстовые слои
   * растеризуются заново из параметров, если пиксели не переданы.
   */
  loadDocument(
    json: DocumentJson,
    data: Map<string, { pixels?: Uint8Array; mask?: Uint8Array; source?: Uint8Array }>,
  ): void {
    this.newDocument(json.width, json.height, 'transparent')
    const doc = this.requireDoc()
    // newDocument создаёт фоновый слой — вычищаем.
    for (const l of doc.layers) {
      l.texture.dispose()
      l.mask?.dispose()
      l.source?.dispose()
      l.blurTex?.dispose()
    }
    doc.layers = []

    const gl = this.ctx.gl
    for (const layerJson of json.layers) {
      const runtime: LayerRuntime = {
        json: structuredClone(layerJson),
        texture: new Texture(gl, json.width, json.height),
        mask: null,
        source: null,
        version: 0,
      }
      const d = data.get(layerJson.id)
      if (d?.pixels) {
        runtime.texture.upload(d.pixels, 0, 0, json.width, json.height)
      } else if (layerJson.kind === 'text') {
        this.rasterizeTextLayer(runtime)
      }
      if (layerJson.hasMask) {
        runtime.mask = new Texture(gl, json.width, json.height, 'r8')
        if (d?.mask) runtime.mask.upload(d.mask, 0, 0, json.width, json.height)
        else {
          doc.attachFbo.attach(runtime.mask)
          doc.attachFbo.clear(1, 0, 0, 1)
        }
      }
      // Оригинал smart-слоя: восстановить, иначе слой деградирует в растровый.
      if (layerJson.kind === 'raster' && layerJson.smart) {
        if (d?.source) {
          runtime.source = new Texture(gl, layerJson.smart.srcW, layerJson.smart.srcH)
          runtime.source.upload(d.source, 0, 0, layerJson.smart.srcW, layerJson.smart.srcH)
        } else if (runtime.json.kind === 'raster') {
          delete runtime.json.smart
        }
      }
      doc.layers.push(runtime)
    }
    doc.activeLayerId =
      json.activeLayerId && doc.layers.some((l) => l.json.id === json.activeLayerId)
        ? json.activeLayerId
        : (doc.layers.at(-1)?.json.id ?? null)
    this.history.clear()
    this.invalidate()
    this.emit()
  }

  /** Закрыть документ (для вкладок): холст пустеет, UI показывает подсказку. */
  closeDocument(): void {
    this.disposeDoc()
    this.maskEditLayerId = null
    this.invalidatePresent()
    this.emit()
  }

  /** Вставка слоя из сериализованных данных (перенос между вкладками). */
  insertSerializedLayer(
    json: LayerJson,
    data: { pixels?: Uint8Array; mask?: Uint8Array; source?: Uint8Array },
  ): string {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    const runtime: LayerRuntime = {
      json: { ...structuredClone(json), id: newLayerId() },
      texture: new Texture(gl, doc.width, doc.height),
      mask: null,
      source: null,
      version: 0,
    }
    if (data.pixels && data.pixels.length === doc.width * doc.height * 4) {
      runtime.texture.upload(data.pixels, 0, 0, doc.width, doc.height)
    }
    if (json.hasMask && data.mask && data.mask.length === doc.width * doc.height) {
      runtime.mask = new Texture(gl, doc.width, doc.height, 'r8')
      runtime.mask.upload(data.mask, 0, 0, doc.width, doc.height)
    } else if (runtime.json.hasMask) {
      runtime.json.hasMask = false
    }
    if (runtime.json.kind === 'raster' && runtime.json.smart) {
      if (data.source) {
        runtime.source = new Texture(gl, runtime.json.smart.srcW, runtime.json.smart.srcH)
        runtime.source.upload(
          data.source,
          0,
          0,
          runtime.json.smart.srcW,
          runtime.json.smart.srcH,
        )
        this.renderSmart(runtime)
      } else {
        delete runtime.json.smart
      }
    }
    this.touch(runtime)
    this.pushInsertLayerCommand(runtime, doc.layers.length, 'history.addLayer')
    return runtime.json.id
  }

  /** Импорт картинки новым документом: холст по размеру, картинка — smart. */
  importImageAsDocument(image: ImageBitmap): void {
    this.newDocument(image.width, image.height, 'transparent')
    this.addImageLayer(image, 'Картинка', 'above')
    // Историю первого импорта не держим — это «начало» документа.
    this.history.clear()
    this.emit()
  }

  /**
   * Импорт картинки SMART-слоем (как Smart Object в Photoshop): оригинал
   * полного разрешения хранится в слое, на холст рендерится с трансформом —
   * перемещение/масштаб без потерь, «за краем холста» ничего не пропадает.
   */
  addImageLayer(image: ImageBitmap, name: string, at: 'above' | 'bottom' = 'above'): string {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    const runtime = this.createRasterRuntime(name)

    const source = new Texture(gl, image.width, image.height)
    source.uploadImage(image, true)
    runtime.source = source
    const k = Math.min(1, doc.width / image.width, doc.height / image.height)
    if (runtime.json.kind === 'raster') {
      runtime.json.smart = {
        srcW: image.width,
        srcH: image.height,
        transform: { cx: doc.width / 2, cy: doc.height / 2, dx: 0, dy: 0, sx: k, sy: k, rot: 0 },
      }
    }
    this.renderSmart(runtime)

    const index = at === 'bottom' ? 0 : this.activeIndex() + 1
    this.pushInsertLayerCommand(runtime, index, 'history.addLayer')
    return runtime.json.id
  }

  /** Перерисовка кэш-текстуры smart-слоя из оригинала (без потерь). */
  private renderSmart(layer: LayerRuntime): void {
    if (layer.json.kind !== 'raster' || !layer.json.smart || !layer.source) return
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    const t = layer.json.smart.transform
    doc.attachFbo.attach(layer.texture)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.progPlace.use()
    layer.source.bind(0)
    this.progPlace.setInt('uTex', 0)
    this.progPlace.setVec2('uSrcSize', layer.json.smart.srcW, layer.json.smart.srcH)
    this.progPlace.setVec2('uCenter', t.cx, t.cy)
    this.progPlace.setVec2('uDelta', t.dx, t.dy)
    this.progPlace.setVec2('uScale', t.sx, t.sy)
    this.progPlace.setFloat('uRot', t.rot)
    this.progPlace.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    this.touch(layer)
    this.invalidate()
  }

  /** Трансформация smart-слоя: живая, без потерь (рендер из оригинала). */
  setSmartTransform(
    id: string,
    patch: Partial<SmartTransform>,
    options: { history?: boolean } = {},
  ): void {
    const layer = this.findLayer(id)
    if (!layer || layer.json.kind !== 'raster' || !layer.json.smart) return
    const before = { ...layer.json.smart.transform }
    const after = { ...before, ...patch }

    const apply = (t: SmartTransform) => {
      if (layer.json.kind === 'raster' && layer.json.smart) {
        layer.json.smart.transform = { ...t }
        this.renderSmart(layer)
      }
    }
    apply(after)
    if (options.history !== false) {
      this.history.push({
        label: 'history.transform',
        redo: () => apply(after),
        undo: () => apply(before),
        bytes: 256,
      })
    }
    this.emit()
  }

  getSmartInfo(id: string): { srcW: number; srcH: number; transform: SmartTransform } | null {
    const layer = this.findLayer(id)
    if (!layer || layer.json.kind !== 'raster' || !layer.json.smart) return null
    return structuredClone(layer.json.smart)
  }

  /**
   * Превращает обычный растровый слой в smart на лету (для перетаскивания
   * рамкой): оригинал = кроп содержимого по альфе. Пустой слой — весь холст.
   */
  convertToSmart(id: string): boolean {
    const doc = this.requireDoc()
    const layer = this.findLayer(id)
    if (!layer || layer.json.kind !== 'raster') return false
    if (layer.json.smart) return true

    doc.attachFbo.attach(layer.texture)
    const pixels = doc.attachFbo.readPixels(0, 0, doc.width, doc.height)
    // bbox по альфе (каждый 4-й байт).
    let x0 = doc.width
    let y0 = doc.height
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        if (pixels[(y * doc.width + x) * 4 + 3]! > 8) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    if (x1 < 0) {
      x0 = 0
      y0 = 0
      x1 = doc.width - 1
      y1 = doc.height - 1
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const crop = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      crop.set(
        pixels.subarray(((y0 + y) * doc.width + x0) * 4, ((y0 + y) * doc.width + x1 + 1) * 4),
        y * w * 4,
      )
    }
    const gl = this.ctx.gl
    const source = new Texture(gl, w, h)
    source.upload(crop, 0, 0, w, h)

    const smart = {
      srcW: w,
      srcH: h,
      transform: { cx: x0 + w / 2, cy: y0 + h / 2, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 },
    }
    const apply = () => {
      if (layer.json.kind === 'raster') layer.json.smart = structuredClone(smart)
      layer.source = source
      this.renderSmart(layer)
    }
    const revert = () => {
      if (layer.json.kind === 'raster') delete layer.json.smart
      layer.source = null
      layer.texture.upload(pixels, 0, 0, doc.width, doc.height)
      this.touch(layer)
      this.invalidate()
    }
    apply()
    this.history.push({
      label: 'history.transform',
      redo: apply,
      undo: revert,
      bytes: crop.byteLength,
      dispose: () => {
        if (layer.source !== source) source.dispose()
      },
    })
    this.emit()
    return true
  }

  // ── Настройка выделения: растушёвка + расширение/сжатие (live) ──
  private adjustBase: Texture | null = null

  /** Запоминает текущее выделение как базу для live-настройки. */
  beginSelectionAdjust(): boolean {
    const doc = this.requireDoc()
    if (!doc.selActive) return false
    const gl = this.ctx.gl
    if (!this.adjustBase || this.adjustBase.width !== doc.width) {
      this.adjustBase?.dispose()
      this.adjustBase = new Texture(gl, doc.width, doc.height, 'r8')
    }
    this.copyTexture(doc.selCur, this.adjustBase)
    return true
  }

  /**
   * Live-превью: base → [расширение/сжатие: blur+threshold] → [растушёвка].
   * expand в px (положительное — «обхватить больше», отрицательное — меньше).
   */
  previewSelectionAdjust(feather: number, expand: number): void {
    const doc = this.requireDoc()
    if (!this.adjustBase) return
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)

    this.copyTexture(this.adjustBase, doc.selCur)

    const e = Math.round(expand)
    if (e !== 0) {
      const radius = Math.min(100, Math.abs(e) * 2)
      this.gaussSelCur(radius)
      doc.selFbo.attach(doc.selScratch)
      doc.selFbo.bind()
      this.progThreshold.use()
      doc.selCur.bind(0)
      this.progThreshold.setInt('uTex', 0)
      this.progThreshold.setFloat('uThreshold', e > 0 ? 0.2 : 0.8)
      this.progThreshold.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
      this.swapSel()
    }

    const f = Math.min(100, Math.max(0, Math.round(feather)))
    if (f > 0) this.gaussSelCur(f)

    this.invalidatePresent()
  }

  /** Фиксация настройки выделения одной записью истории. */
  commitSelectionAdjust(feather: number, expand: number): void {
    const doc = this.requireDoc()
    if (!this.adjustBase) return
    this.copyTexture(this.adjustBase, doc.selCur)
    this.applySelectionChange('history.feather', () => {
      this.previewSelectionAdjust(feather, expand)
    })
    this.adjustBase?.dispose()
    this.adjustBase = null
  }

  cancelSelectionAdjust(): void {
    const doc = this.doc
    if (doc && this.adjustBase) this.copyTexture(this.adjustBase, doc.selCur)
    this.adjustBase?.dispose()
    this.adjustBase = null
    this.invalidatePresent()
  }

  /** Сепарабельный гаусс selCur на месте. */
  private gaussSelCur(radius: number): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)
    this.progGauss.use()
    this.progGauss.setInt('uTex', 0)
    this.progGauss.setInt('uRadius', radius)
    this.progGauss.setVec4('uRect', ...FULL_RECT)
    doc.selFbo.attach(doc.selScratch)
    doc.selFbo.bind()
    doc.selCur.bind(0)
    this.progGauss.setVec2('uDir', 1 / doc.width, 0)
    this.quad.draw()
    this.swapSel()
    doc.selFbo.attach(doc.selScratch)
    doc.selFbo.bind()
    doc.selCur.bind(0)
    this.progGauss.setVec2('uDir', 0, 1 / doc.height)
    this.quad.draw()
    this.swapSel()
  }

  /** Растеризация smart-слоя (перед рисованием кистью и т.п.). */
  rasterizeSmartLayer(id: string): void {
    const layer = this.findLayer(id)
    if (!layer || layer.json.kind !== 'raster' || !layer.json.smart) return
    const smart = structuredClone(layer.json.smart)
    const source = layer.source

    const apply = () => {
      if (layer.json.kind === 'raster') delete layer.json.smart
      layer.source = null
      this.invalidate()
    }
    const revert = () => {
      if (layer.json.kind === 'raster') layer.json.smart = structuredClone(smart)
      layer.source = source
      this.invalidate()
    }
    apply()
    this.history.push({
      label: 'history.rasterize',
      redo: apply,
      undo: revert,
      bytes: source?.bytes ?? 256,
      dispose: () => {
        // Если слой так и остался растровым — оригинал больше не нужен.
        if (layer.source !== source) source?.dispose()
      },
    })
    this.emit()
  }

  /** Чтение default framebuffer после render() — для тестов present-прохода. */
  readDisplayPixels(): { pixels: Uint8Array; width: number; height: number } {
    const gl = this.ctx.gl
    const w = this.canvas.width
    const h = this.canvas.height
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const out = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return { pixels: out, width: w, height: h }
  }

  readComposite(): { pixels: Uint8Array; width: number; height: number } {
    const doc = this.requireDoc()
    if (this.compositeDirty) this.compose()
    doc.attachFbo.attach(doc.composite)
    return {
      pixels: doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
      width: doc.width,
      height: doc.height,
    }
  }

  /** Заливка активного слоя цветом (для тестов и инициализации). */
  fillActiveLayer(color: RgbaColor): void {
    const doc = this.requireDoc()
    const layer = this.findLayer(doc.activeLayerId ?? '')
    if (!layer) return
    this.fillTexture(layer.texture, color)
    this.touch(layer)
    this.invalidate()
  }

  dispose(): void {
    this.disposeDoc()
    for (const tip of this.brushTips.values()) tip.dispose()
    this.brushTips.clear()
  }

  // ───────────────────────── Внутренности ─────────────────────────

  private compose(): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)

    doc.accumA.clear()
    this.composeDst = doc.accumA
    this.composeDstIsA = true

    for (let i = 0; i < doc.layers.length; i++) {
      const layer = doc.layers[i]!
      if (!layer.json.visible || layer.json.opacity === 0) continue

      // Обтравка: база — ближайший не-clipped слой ниже.
      let clipBase: LayerRuntime | null = null
      if (layer.json.clipped) {
        for (let j = i - 1; j >= 0; j--) {
          if (!doc.layers[j]!.json.clipped) {
            clipBase = doc.layers[j]!
            break
          }
        }
        if (!clipBase || !clipBase.json.visible) continue
      }

      let srcTex = layer.texture
      let maskTex = layer.mask
      if (this.stroke && this.stroke.layerId === layer.json.id) {
        if (this.stroke.target === 'mask' && layer.mask) {
          this.mergeStrokeMask(layer.mask, this.stroke, doc.selShape)
          maskTex = doc.selShape
        } else if (this.stroke.target === 'pixels') {
          this.mergeStroke(layer.texture, this.stroke, doc.scratch)
          srcTex = doc.scratch.texture
        }
      }

      const { opacity } = layer.json
      const clipTex = clipBase?.texture ?? null

      // Размытия слоя (гаусс/движение) — до теней: тени строятся по
      // уже размытому силуэту, как выглядел бы отфильтрованный слой.
      srcTex = this.applyLayerBlur(layer, srcTex)
      // Наложение цвета — поверх (размытых) пикселей, альфа не меняется.
      srcTex = this.applyColorOverlay(layer.json.styles, srcTex)

      // Внешняя тень — под слоем.
      const drop = layer.json.styles?.dropShadow
      if (drop?.enabled) {
        this.buildShadow(srcTex, maskTex, drop, false)
        this.blendOnto(doc.styleColor, opacity, 'normal', null, clipTex)
      }

      // Внешнее свечение — под слоем, режим screen (как в Photoshop).
      const glow = layer.json.styles?.outerGlow
      if (glow?.enabled) {
        this.buildShadow(
          srcTex,
          maskTex,
          {
            enabled: true,
            color: glow.color,
            opacity: glow.opacity,
            distance: 0,
            angle: 0,
            size: glow.size,
            ...(glow.spread !== undefined ? { spread: glow.spread } : {}),
          },
          false,
        )
        this.blendOnto(doc.styleColor, opacity, 'screen', null, clipTex)
      }

      this.blendOnto(srcTex, opacity, layer.json.blendMode, maskTex, clipTex)

      // Плавающий фрагмент рисуется поверх своего слоя.
      if (this.floating && this.floating.layerId === layer.json.id) {
        const gl2 = this.ctx.gl
        this.composeDst!.bind()
        gl2.enable(gl2.BLEND)
        gl2.blendFunc(gl2.ONE, gl2.ONE_MINUS_SRC_ALPHA)
        this.drawFloating(this.floating, this.floating.tex)
        gl2.disable(gl2.BLEND)
      }

      // Внутренняя тень — поверх слоя, клип по его альфе.
      const inner = layer.json.styles?.innerShadow
      if (inner?.enabled) {
        this.buildShadow(srcTex, maskTex, inner, true)
        this.blendOnto(doc.styleColor, opacity, 'normal', null, clipTex)
      }
    }

    doc.composite = this.composeDst!.texture
    this.compositeDirty = false
  }

  private composeDst: Fbo | null = null
  private composeDstIsA = true

  /** Один шаг композиции: пинг-понг аккумуляторов. */
  private blendOnto(
    srcTex: Texture,
    opacity: number,
    mode: BlendMode,
    maskTex: Texture | null,
    clipTex: Texture | null,
  ): void {
    const doc = this.requireDoc()
    const dst = this.composeDst!
    const target = this.composeDstIsA ? doc.accumB : doc.accumA
    target.bind()
    this.progBlend.use()
    dst.texture.bind(0)
    srcTex.bind(1)
    this.progBlend.setInt('uDst', 0)
    this.progBlend.setInt('uSrc', 1)
    if (maskTex) {
      maskTex.bind(2)
      this.progBlend.setInt('uMask', 2)
    }
    this.progBlend.setInt('uUseMask', maskTex ? 1 : 0)
    if (clipTex) {
      clipTex.bind(3)
      this.progBlend.setInt('uClip', 3)
    }
    this.progBlend.setInt('uUseClip', clipTex ? 1 : 0)
    this.progBlend.setFloat('uOpacity', opacity)
    this.progBlend.setInt('uMode', MODE_INDEX[mode] ?? 0)
    this.progBlend.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()

    this.composeDst = target
    this.composeDstIsA = !this.composeDstIsA
  }

  /**
   * Стили «Размытие по Гауссу» / «Размытие в движении»: возвращает srcTex
   * без изменений или размытую копию. Результат кэшируется в слое по
   * (version, параметры) — полноэкранный гаусс на каждый кадр слишком дорог.
   * Во время штриха srcTex — «мокрый» скретч, кэш не используется.
   */
  private applyLayerBlur(layer: LayerRuntime, srcTex: Texture): Texture {
    const styles = layer.json.styles
    const g = styles?.gaussianBlur
    const m = styles?.motionBlur
    const gaussR = g?.enabled ? Math.min(100, Math.max(0, Math.round(g.radius))) : 0
    const motionD = m?.enabled ? Math.min(300, Math.max(0, m.distance)) : 0
    if (gaussR <= 0 && motionD < 1) {
      if (layer.blurTex) {
        layer.blurTex.dispose()
        layer.blurTex = null
        layer.blurKey = ''
      }
      return srcTex
    }

    const doc = this.requireDoc()
    const gl = this.ctx.gl
    // Угол смаза задан относительно объекта: поворот слоя добавляется,
    // чтобы смаз вращался вместе с ним.
    let angle = m?.angle ?? 0
    if (layer.json.kind === 'raster' && layer.json.smart) {
      angle += (layer.json.smart.transform.rot * 180) / Math.PI
    } else if (layer.json.kind === 'text') {
      angle += layer.json.text.rotation ?? 0
    }
    const cacheable = srcTex === layer.texture
    const key = `${layer.version}|${gaussR}|${motionD}|${angle}`
    if (cacheable && layer.blurTex && layer.blurKey === key) return layer.blurTex

    gl.disable(gl.BLEND)
    if (cacheable && !layer.blurTex) layer.blurTex = new Texture(gl, doc.width, doc.height)

    const pass = (prog: Program, src: Texture, dst: Texture): void => {
      doc.attachFbo.attach(dst)
      doc.attachFbo.bind()
      src.bind(0)
      prog.setInt('uTex', 0)
      prog.setVec4('uRect', ...FULL_RECT)
      this.quad.draw()
    }
    const gaussPass = (src: Texture, dst: Texture, r: number, dx: number, dy: number): void => {
      this.progGaussRgba.use()
      this.progGaussRgba.setInt('uRadius', r)
      this.progGaussRgba.setVec2('uDir', dx, dy)
      pass(this.progGaussRgba, src, dst)
    }
    const motionPass = (src: Texture, dst: Texture): void => {
      const rad = (angle * Math.PI) / 180
      this.progMotion.use()
      // uVec в uv-единицах — одинаков на любом разрешении.
      this.progMotion.setVec2(
        'uVec',
        (Math.cos(rad) * motionD) / doc.width,
        (Math.sin(rad) * motionD) / doc.height,
      )
      pass(this.progMotion, src, dst)
    }

    // Большие радиусы — на уменьшенном разрешении: гаусс O(R) на полном
    // разрешении фризит перетаскивание (кэш при движении бессилен — пиксели
    // слоя меняются каждый кадр). Blur R на 1/f разрешении с радиусом R/f
    // визуально неотличим — содержимое и так размыто.
    const factor = Math.min(
      8,
      Math.max(
        gaussR > 12 ? 2 ** Math.ceil(Math.log2(gaussR / 12)) : 1,
        motionD > 64 ? 2 : 1,
      ),
    )

    if (factor > 1) {
      // Даунскейл каскадом половинок (linear на каждом шаге ≈ box-фильтр).
      let small = srcTex
      for (let f = 2; f <= factor; f *= 2) {
        let p = doc.blurSmall.get(f)
        if (!p) {
          const sw = Math.max(1, Math.ceil(doc.width / f))
          const sh = Math.max(1, Math.ceil(doc.height / f))
          p = { a: new Texture(gl, sw, sh), b: new Texture(gl, sw, sh) }
          doc.blurSmall.set(f, p)
        }
        this.progCopy.use()
        pass(this.progCopy, small, p.a)
        small = p.a
      }
      const pair = doc.blurSmall.get(factor)!
      if (gaussR > 0) {
        const r = Math.max(1, Math.round(gaussR / factor))
        gaussPass(small, pair.b, r, 1 / pair.a.width, 0)
        gaussPass(pair.b, pair.a, r, 0, 1 / pair.a.height)
        small = pair.a
      }
      if (motionD >= 1) {
        const dst = small === pair.a ? pair.b : pair.a
        motionPass(small, dst)
        small = dst
      }
      const finalTarget = cacheable
        ? layer.blurTex!
        : (doc.blurA ??= new Texture(gl, doc.width, doc.height))
      this.progCopy.use()
      pass(this.progCopy, small, finalTarget) // апскейл (linear)
      if (cacheable) layer.blurKey = key
      return finalTarget
    }

    if (!doc.blurA) doc.blurA = new Texture(gl, doc.width, doc.height)
    if (!doc.blurB) doc.blurB = new Texture(gl, doc.width, doc.height)
    const finalTarget = cacheable
      ? layer.blurTex!
      : gaussR > 0 && motionD >= 1
        ? doc.blurB
        : doc.blurA

    let cur = srcTex
    if (gaussR > 0) {
      gaussPass(cur, doc.blurB, gaussR, 1 / doc.width, 0)
      const vDst = motionD >= 1 ? doc.blurA : finalTarget
      gaussPass(doc.blurB, vDst, gaussR, 0, 1 / doc.height)
      cur = vDst
    }
    if (motionD >= 1) {
      motionPass(cur, finalTarget)
      cur = finalTarget
    }
    if (cacheable) layer.blurKey = key
    return cur
  }

  /**
   * Стиль «Наложение цвета»: перекрашивает видимые пиксели (premult, альфа
   * сохраняется). Дешёвый один проход — кэш не нужен.
   */
  private applyColorOverlay(styles: LayerStyles | undefined, srcTex: Texture): Texture {
    const o = styles?.colorOverlay
    if (!o?.enabled || o.opacity <= 0) return srcTex
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)
    if (!doc.blurA) doc.blurA = new Texture(gl, doc.width, doc.height)
    if (!doc.blurB) doc.blurB = new Texture(gl, doc.width, doc.height)
    const target = srcTex === doc.blurA ? doc.blurB : doc.blurA
    doc.attachFbo.attach(target)
    doc.attachFbo.bind()
    this.progColorOverlay.use()
    srcTex.bind(0)
    this.progColorOverlay.setInt('uTex', 0)
    const [r, g, b] = hexToRgb(o.color)
    this.progColorOverlay.setVec4('uColor', r, g, b, Math.max(0, Math.min(1, o.opacity)))
    this.progColorOverlay.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    return target
  }

  /** Готовит premult-цветную тень слоя в doc.styleColor. */
  private buildShadow(
    srcTex: Texture,
    maskTex: Texture | null,
    style: ShadowStyle,
    inner: boolean,
  ): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)
    const rad = (style.angle * Math.PI) / 180
    const offX = (Math.cos(rad) * style.distance) / doc.width
    const offY = (Math.sin(rad) * style.distance) / doc.height

    // 1. Маска тени (альфа со смещением) → styleA.
    doc.attachFbo.attach(doc.styleA)
    doc.attachFbo.bind()
    this.progShadowMask.use()
    srcTex.bind(0)
    this.progShadowMask.setInt('uSrc', 0)
    if (maskTex) {
      maskTex.bind(1)
      this.progShadowMask.setInt('uMask', 1)
    }
    this.progShadowMask.setInt('uUseMask', maskTex ? 1 : 0)
    this.progShadowMask.setVec2('uOffset', offX, offY)
    this.progShadowMask.setInt('uInvert', inner ? 1 : 0)
    this.progShadowMask.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()

    // Пинг-понг styleA↔styleB; после пары проходов результат снова в cur.
    let cur = doc.styleA
    let other = doc.styleB
    const gaussPass = (radius: number): void => {
      this.progGauss.use()
      this.progGauss.setInt('uTex', 0)
      this.progGauss.setInt('uRadius', radius)
      this.progGauss.setVec4('uRect', ...FULL_RECT)
      doc.attachFbo.attach(other)
      doc.attachFbo.bind()
      cur.bind(0)
      this.progGauss.setVec2('uDir', 1 / doc.width, 0)
      this.quad.draw()
      ;[cur, other] = [other, cur]
      doc.attachFbo.attach(other)
      doc.attachFbo.bind()
      cur.bind(0)
      this.progGauss.setVec2('uDir', 0, 1 / doc.height)
      this.quad.draw()
      ;[cur, other] = [other, cur]
    }

    // 2. «Размер» (spread, px): дилатация маски — размытие + низкий порог
    //    отодвигают край наружу примерно на spread px (тень плотнеет и растёт).
    const spread = Math.min(50, Math.max(0, Math.round(style.spread ?? 0)))
    if (spread > 0) {
      gaussPass(Math.min(100, spread * 2))
      this.progThreshold.use()
      this.progThreshold.setInt('uTex', 0)
      this.progThreshold.setFloat('uThreshold', 0.16)
      this.progThreshold.setVec4('uRect', ...FULL_RECT)
      doc.attachFbo.attach(other)
      doc.attachFbo.bind()
      cur.bind(0)
      this.quad.draw()
      ;[cur, other] = [other, cur]
    }

    // 3. «Размытие» (size, px): гаусс.
    const radius = Math.min(100, Math.max(0, Math.round(style.size)))
    if (radius > 0) gaussPass(radius)

    // 4. Колоризация → styleColor (premult RGBA).
    doc.attachFbo.attach(doc.styleColor)
    doc.attachFbo.bind()
    this.progShadowColor.use()
    cur.bind(0)
    srcTex.bind(1)
    this.progShadowColor.setInt('uMaskTex', 0)
    this.progShadowColor.setInt('uSrc', 1)
    if (maskTex) {
      maskTex.bind(2)
      this.progShadowColor.setInt('uMask', 2)
    }
    this.progShadowColor.setInt('uUseMask', maskTex ? 1 : 0)
    const [r, g, b] = hexToRgb(style.color)
    this.progShadowColor.setVec4('uColor', r, g, b, style.opacity)
    this.progShadowColor.setInt('uClipToAlpha', inner ? 1 : 0)
    this.progShadowColor.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
  }

  private present(): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    const cw = this.canvas.width
    const ch = this.canvas.height
    if (cw === 0 || ch === 0) return

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, cw, ch)
    gl.clearColor(0.106, 0.106, 0.122, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.BLEND)

    const v = this.view
    const x0 = ((v.panX * this.dpr) / cw) * 2 - 1
    const yTop = 1 - ((v.panY * this.dpr) / ch) * 2
    const w = ((doc.width * v.scale * this.dpr) / cw) * 2
    const h = -((doc.height * v.scale * this.dpr) / ch) * 2

    // Резкие пиксели на увеличении; сетка появляется от 8× (как в PS от ~800%).
    const zoomPx = v.scale * this.dpr
    doc.composite.setMagFilter(zoomPx >= 3 ? 'nearest' : 'linear')
    const gridAlpha = zoomPx >= 8 ? Math.min(0.55, (zoomPx - 8) / 8 + 0.25) : 0

    this.progPresent.use()
    doc.composite.bind(0)
    this.progPresent.setInt('uTex', 0)
    this.progPresent.setVec2(
      'uDocSizePx',
      doc.width * v.scale * this.dpr,
      doc.height * v.scale * this.dpr,
    )
    this.progPresent.setVec2('uDocDims', doc.width, doc.height)
    this.progPresent.setFloat('uGridAlpha', gridAlpha)
    this.progPresent.setFloat('uCheckSize', 8 * this.dpr)
    this.progPresent.setVec4('uRect', x0, yTop, w, h)
    this.quad.draw()

    if (doc.selActive && !this.floating) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      this.progAnts.use()
      doc.selCur.bind(0)
      this.progAnts.setInt('uSel', 0)
      this.progAnts.setFloat('uTime', performance.now() / 1000)
      this.progAnts.setVec2(
        'uQuadPx',
        doc.width * v.scale * this.dpr,
        doc.height * v.scale * this.dpr,
      )
      this.progAnts.setVec4('uRect', x0, yTop, w, h)
      this.quad.draw()
      gl.disable(gl.BLEND)
    }

    // Превью кисти выделения: муравьи по текущему штриху.
    if (this.stroke?.target === 'selection') {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
      this.progAnts.use()
      doc.strokeTex.bind(0)
      this.progAnts.setInt('uSel', 0)
      this.progAnts.setFloat('uTime', performance.now() / 1000)
      this.progAnts.setVec2(
        'uQuadPx',
        doc.width * v.scale * this.dpr,
        doc.height * v.scale * this.dpr,
      )
      this.progAnts.setVec4('uRect', x0, yTop, w, h)
      this.quad.draw()
      gl.disable(gl.BLEND)
    }
  }

  private stampDabs(dabs: { x: number; y: number; size: number; flow: number }[]): void {
    if (!this.doc || !this.stroke || dabs.length === 0) return
    const gl = this.ctx.gl
    const doc = this.doc

    const tip = this.stroke.brush.tipId ? this.brushTips.get(this.stroke.brush.tipId) : undefined
    const prog = tip ? this.progDabTip : this.progDab

    doc.strokeFbo.bind()
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    prog.use()
    if (tip) {
      tip.bind(1)
      prog.setInt('uTip', 1)
    } else {
      prog.setFloat('uHardness', this.stroke.brush.hardness)
    }
    // Выделение клипит обычный штрих; кисти выделения оно клипить не должно.
    const clipBySel = doc.selActive && this.stroke.target !== 'selection'
    if (clipBySel) {
      doc.selCur.bind(2)
      prog.setInt('uSel', 2)
    }
    prog.setInt('uUseSel', clipBySel ? 1 : 0)
    prog.setVec2('uDocSize', doc.width, doc.height)

    for (const dab of dabs) {
      const r = dab.size / 2
      const x0 = ((dab.x - r) / doc.width) * 2 - 1
      const y0 = ((dab.y - r) / doc.height) * 2 - 1
      const w = (dab.size / doc.width) * 2
      const h = (dab.size / doc.height) * 2
      this.progDab.setFloat('uFlow', dab.flow)
      this.progDab.setVec4('uRect', x0, y0, w, h)
      this.quad.draw()

      this.growDirty({
        x: Math.floor(dab.x - r) - 1,
        y: Math.floor(dab.y - r) - 1,
        w: Math.ceil(dab.size) + 2,
        h: Math.ceil(dab.size) + 2,
      })
    }
    gl.disable(gl.BLEND)
    this.invalidate()
  }

  private mergeStroke(layerTex: Texture, stroke: ActiveStroke, target: Fbo): void {
    const gl = this.ctx.gl
    target.bind()
    gl.disable(gl.BLEND)
    this.progMerge.use()
    layerTex.bind(0)
    this.doc!.strokeTex.bind(1)
    this.progMerge.setInt('uLayer', 0)
    this.progMerge.setInt('uStroke', 1)
    const [r, g, b, a] = stroke.color
    this.progMerge.setVec4('uColor', r, g, b, a)
    this.progMerge.setFloat('uOpacity', stroke.brush.opacity)
    this.progMerge.setInt('uErase', stroke.mode === 'erase' ? 1 : 0)
    this.progMerge.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
  }

  private mergeStrokeMask(maskTex: Texture, stroke: ActiveStroke, targetTex: Texture): void {
    const gl = this.ctx.gl
    const doc = this.requireDoc()
    doc.selFbo.attach(targetTex)
    doc.selFbo.bind()
    gl.disable(gl.BLEND)
    this.progMergeMask.use()
    maskTex.bind(0)
    doc.strokeTex.bind(1)
    this.progMergeMask.setInt('uLayer', 0)
    this.progMergeMask.setInt('uStroke', 1)
    const [r, g, b] = stroke.color
    this.progMergeMask.setFloat('uValue', 0.2126 * r + 0.7152 * g + 0.0722 * b)
    this.progMergeMask.setFloat('uOpacity', stroke.brush.opacity)
    this.progMergeMask.setInt('uErase', stroke.mode === 'erase' ? 1 : 0)
    this.progMergeMask.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
  }

  private uploadPatch(layerId: string, target: StrokeTarget, patch: PixelPatch): void {
    const layer = this.findLayer(layerId)
    if (!layer) return
    const tex = target === 'mask' ? layer.mask : layer.texture
    if (!tex) return
    const { rect } = patch
    tex.upload(patch.unpack(), rect.x, rect.y, rect.w, rect.h)
    this.touch(layer)
    this.invalidate()
  }

  // ── Выделение: служебное ──

  /** Обёртка истории для операций с выделением: before/after всей маски. */
  private applySelectionChange(label: string, fn: () => void): void {
    const doc = this.requireDoc()
    const wasActive = doc.selActive
    doc.attachFbo.attach(doc.selCur)
    const before = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )

    fn()

    doc.attachFbo.attach(doc.selCur)
    const after = new PixelPatch(
      { x: 0, y: 0, w: doc.width, h: doc.height },
      doc.attachFbo.readPixels(0, 0, doc.width, doc.height),
    )
    const isActive = doc.selActive
    const engine = this

    this.history.push({
      label,
      bytes: before.bytes + after.bytes,
      undo: () => engine.restoreSelection(before, wasActive),
      redo: () => engine.restoreSelection(after, isActive),
    })
    this.invalidatePresent()
    this.emit()
  }

  private restoreSelection(patch: PixelPatch, active: boolean): void {
    const doc = this.requireDoc()
    doc.selCur.upload(patch.unpack(), 0, 0, doc.width, doc.height)
    doc.selActive = active
    this.invalidatePresent()
  }

  /** Комбинирует растр фигуры с текущим выделением (selShape → selCombine → swap). */
  private combineShape(shape: Uint8Array, op: SelectionOp): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    doc.selShape.upload(shape, 0, 0, doc.width, doc.height)

    doc.selFbo.attach(doc.selScratch)
    doc.selFbo.bind()
    gl.disable(gl.BLEND)
    this.progSelCombine.use()
    doc.selCur.bind(0)
    doc.selShape.bind(1)
    this.progSelCombine.setInt('uA', 0)
    this.progSelCombine.setInt('uB', 1)
    this.progSelCombine.setInt('uOp', OP_INDEX[op])
    this.progSelCombine.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    this.swapSel()
    doc.selActive = true
  }

  private swapSel(): void {
    const doc = this.requireDoc()
    const tmp = doc.selCur
    doc.selCur = doc.selScratch
    doc.selScratch = tmp
  }

  // ── Прочее служебное ──

  private copyTexture(src: Texture, dst: Texture): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    doc.attachFbo.attach(dst)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    this.progCopy.use()
    src.bind(0)
    this.progCopy.setInt('uTex', 0)
    this.progCopy.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
  }

  /** Копия src в dst со смещением (dx, dy) в док-px; фон прозрачный или белый (для масок). */
  private blitOffset(dst: Texture, src: Texture, dx: number, dy: number, whiteBg: boolean): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    doc.attachFbo.attach(dst)
    doc.attachFbo.bind()
    gl.disable(gl.BLEND)
    const bg = whiteBg ? 1 : 0
    gl.clearColor(bg, bg, bg, bg)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.progCopy.use()
    src.bind(0)
    this.progCopy.setInt('uTex', 0)
    this.progCopy.setVec4(
      'uRect',
      (dx / dst.width) * 2 - 1,
      (dy / dst.height) * 2 - 1,
      (src.width / dst.width) * 2,
      (src.height / dst.height) * 2,
    )
    this.quad.draw()
  }

  /** Пересоздаёт служебные буферы документа под новый размер (выделение сбрасывается). */
  private reallocDocBuffers(width: number, height: number): void {
    const doc = this.requireDoc()
    const gl = this.ctx.gl
    doc.width = width
    doc.height = height
    doc.accumA.texture.dispose()
    doc.accumA.attach(new Texture(gl, width, height))
    doc.accumB.texture.dispose()
    doc.accumB.attach(new Texture(gl, width, height))
    doc.scratch.texture.dispose()
    doc.scratch.attach(new Texture(gl, width, height))
    doc.strokeTex.dispose()
    doc.strokeTex = new Texture(gl, width, height, 'r8')
    doc.strokeFbo.attach(doc.strokeTex)
    doc.selCur.dispose()
    doc.selCur = new Texture(gl, width, height, 'r8')
    doc.selScratch.dispose()
    doc.selScratch = new Texture(gl, width, height, 'r8')
    doc.selShape.dispose()
    doc.selShape = new Texture(gl, width, height, 'r8')
    doc.selFbo.attach(doc.selCur)
    doc.selActive = false
    doc.styleA.dispose()
    doc.styleA = new Texture(gl, width, height, 'r8')
    doc.styleB.dispose()
    doc.styleB = new Texture(gl, width, height, 'r8')
    doc.styleColor.dispose()
    doc.styleColor = new Texture(gl, width, height)
    doc.blurA?.dispose()
    doc.blurA = null
    doc.blurB?.dispose()
    doc.blurB = null
    for (const pair of doc.blurSmall.values()) {
      pair.a.dispose()
      pair.b.dispose()
    }
    doc.blurSmall.clear()
    doc.composite = doc.accumA.texture
  }

  private rasterizeTextLayer(layer: LayerRuntime): void {
    if (layer.json.kind !== 'text') return
    const doc = this.requireDoc()
    const img = rasterizeText(layer.json.text, doc.width, doc.height)
    layer.texture.uploadImage(img, true)
    this.touch(layer)
  }

  private pushInsertLayerCommand(runtime: LayerRuntime, index: number, label: string): void {
    const doc = this.requireDoc()
    const insert = () => {
      doc.layers.splice(Math.min(index, doc.layers.length), 0, runtime)
      doc.activeLayerId = runtime.json.id
      this.invalidate()
    }
    const remove = () => {
      const i = doc.layers.findIndex((l) => l.json.id === runtime.json.id)
      if (i >= 0) doc.layers.splice(i, 1)
      if (doc.activeLayerId === runtime.json.id) {
        doc.activeLayerId = doc.layers[Math.max(0, i - 1)]?.json.id ?? null
      }
      this.invalidate()
    }
    insert()
    this.history.push({
      label,
      redo: insert,
      undo: remove,
      bytes: 256,
      dispose: () => {
        if (!doc.layers.includes(runtime)) {
          runtime.texture.dispose()
          runtime.mask?.dispose()
          runtime.source?.dispose()
          runtime.blurTex?.dispose()
        }
      },
    })
    this.emit()
  }

  private createRasterRuntime(name: string): LayerRuntime {
    const { width, height } = this.requireDoc()
    return {
      json: {
        kind: 'raster',
        id: newLayerId(),
        name,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        clipped: false,
        hasMask: false,
      },
      texture: new Texture(this.ctx.gl, width, height),
      mask: null,
      source: null,
      version: 0,
    }
  }

  /** Пиксели слоя изменились — миниатюра в UI должна перегенериться. */
  private touch(layer: LayerRuntime): void {
    layer.version++
  }

  private fillTexture(tex: Texture, color: RgbaColor): void {
    const doc = this.requireDoc()
    doc.attachFbo.attach(tex)
    doc.attachFbo.bind()
    const gl = this.ctx.gl
    gl.disable(gl.BLEND)
    this.progFill.use()
    const [r, g, b, a] = color
    this.progFill.setVec4('uColor', r * a, g * a, b * a, a)
    this.progFill.setVec4('uRect', ...FULL_RECT)
    this.quad.draw()
    this.invalidate()
  }

  private growDirty(r: Rect): void {
    if (!this.stroke) return
    const d = this.stroke.dirty
    if (!d) {
      this.stroke.dirty = { ...r }
      return
    }
    const x0 = Math.min(d.x, r.x)
    const y0 = Math.min(d.y, r.y)
    const x1 = Math.max(d.x + d.w, r.x + r.w)
    const y1 = Math.max(d.y + d.h, r.y + r.h)
    this.stroke.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  private clampRect(r: Rect): Rect {
    const doc = this.requireDoc()
    const x = Math.max(0, r.x)
    const y = Math.max(0, r.y)
    const x1 = Math.min(doc.width, r.x + r.w)
    const y1 = Math.min(doc.height, r.y + r.h)
    return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) }
  }

  private activeIndex(): number {
    const doc = this.requireDoc()
    return Math.max(
      0,
      doc.layers.findIndex((l) => l.json.id === doc.activeLayerId),
    )
  }

  private findLayer(id: string): LayerRuntime | null {
    return this.doc?.layers.find((l) => l.json.id === id) ?? null
  }

  private requireDoc(): DocRuntime {
    if (!this.doc) throw new Error('Нет открытого документа')
    return this.doc
  }

  private invalidate(): void {
    this.compositeDirty = true
    this.presentQueued = true
  }

  private invalidatePresent(): void {
    this.presentQueued = true
  }

  private emit(): void {
    this.onChange?.()
  }

  private disposeDoc(): void {
    const doc = this.doc
    if (!doc) return
    if (this.floating) {
      this.floating.tex.dispose()
      this.floating.selTex.dispose()
      this.floating = null
    }
    this.history.clear()
    for (const l of doc.layers) {
      l.texture.dispose()
      l.mask?.dispose()
      l.source?.dispose()
      l.blurTex?.dispose()
    }
    doc.accumA.texture.dispose()
    doc.accumB.texture.dispose()
    doc.scratch.texture.dispose()
    doc.strokeTex.dispose()
    doc.selCur.dispose()
    doc.selScratch.dispose()
    doc.selShape.dispose()
    doc.styleA.dispose()
    doc.styleB.dispose()
    doc.styleColor.dispose()
    doc.blurA?.dispose()
    doc.blurB?.dispose()
    for (const pair of doc.blurSmall.values()) {
      pair.a.dispose()
      pair.b.dispose()
    }
    doc.accumA.dispose()
    doc.accumB.dispose()
    doc.scratch.dispose()
    doc.strokeFbo.dispose()
    doc.attachFbo.dispose()
    doc.selFbo.dispose()
    this.doc = null
  }
}
