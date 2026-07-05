import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { measureTextBounds, type FloatingState } from '@slojka/engine'
import { editor, hexToRgba } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import {
  samAddPoint,
  samRemovePointNear,
  samSessionActive,
  samSetBox,
  useSamStore,
} from '../tools/samTool'
import { applyCrop } from '../tools/cropTool'

interface DragState {
  kind:
    | 'pan'
    | 'rect'
    | 'ellipse'
    | 'lasso'
    | 'sam-box'
    | 'text-move'
    | 'float-move'
    | 'float-scale'
    | 'float-rotate'
    | 'text-box'
    | 'crop-new'
    | 'crop-move'
    | 'crop-handle'
  startX: number
  startY: number
  lastX: number
  lastY: number
  points: { x: number; y: number }[]
  textLayerId?: string
  /** Снимок трансформации на момент захвата (floating или smart). */
  floatStart?: UiTransform
  /** Индекс ручки трансформации. */
  handle?: number
  /** Рамка кадрирования на момент захвата (док-координаты). */
  cropStart?: { x: number; y: number; w: number; h: number }
}

const RULER = 20

/** Объект трансформации для рамки: floating, smart-слой или текст. */
interface UiTransform extends FloatingState {
  smartLayerId?: string
  textLayerId?: string
  textBase?: {
    x: number
    y: number
    fontSize: number
    rotation: number
    boxW?: number
    boxH?: number
  }
}

function getTransformBox(): UiTransform | null {
  const f = editor.floatingState
  if (f) return f
  const state = useEditorStore.getState()
  const doc = state.docJson
  if (state.tool !== 'move' || !doc?.activeLayerId) return null
  const layer = doc.layers.find((l) => l.id === doc.activeLayerId)
  if (!layer) return null

  if (layer.kind === 'text') {
    const b = measureTextBounds(layer.text)
    return {
      layerId: layer.id,
      textLayerId: layer.id,
      textBase: {
        x: layer.text.x,
        y: layer.text.y,
        fontSize: layer.text.fontSize,
        rotation: layer.text.rotation ?? 0,
        ...(layer.text.boxW !== undefined ? { boxW: layer.text.boxW } : {}),
        ...(layer.text.boxH !== undefined ? { boxH: layer.text.boxH } : {}),
      },
      bbox: b,
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
      dx: 0,
      dy: 0,
      sx: 1,
      sy: 1,
      rot: ((layer.text.rotation ?? 0) * Math.PI) / 180,
    }
  }

  const info = editor.getSmartInfo(doc.activeLayerId)
  if (!info) return null
  const t = info.transform
  return {
    layerId: doc.activeLayerId,
    smartLayerId: doc.activeLayerId,
    bbox: { x: t.cx - info.srcW / 2, y: t.cy - info.srcH / 2, w: info.srcW, h: info.srcH },
    cx: t.cx,
    cy: t.cy,
    dx: t.dx,
    dy: t.dy,
    sx: t.sx,
    sy: t.sy,
    rot: t.rot,
  }
}

/** Применение патча трансформации к floating, smart-слою или тексту (live). */
function applyTransformPatch(
  d: { floatStart?: UiTransform },
  patch: Partial<Pick<FloatingState, 'dx' | 'dy' | 'sx' | 'sy' | 'rot'>>,
): void {
  const f = d.floatStart
  if (f?.textLayerId && f.textBase) {
    const base = f.textBase
    const scale = patch.sx ?? patch.sy
    editor.setTextParams(
      f.textLayerId,
      {
        ...(patch.dx !== undefined ? { x: Math.round(base.x + patch.dx) } : {}),
        ...(patch.dy !== undefined ? { y: Math.round(base.y + patch.dy) } : {}),
        ...(patch.rot !== undefined ? { rotation: Math.round((patch.rot * 180) / Math.PI) } : {}),
        ...(scale !== undefined
          ? {
              fontSize: Math.max(4, Math.round(base.fontSize * scale)),
              ...(base.boxW !== undefined ? { boxW: Math.round(base.boxW * scale) } : {}),
              ...(base.boxH !== undefined ? { boxH: Math.round(base.boxH * scale) } : {}),
            }
          : {}),
      },
      false,
    )
    return
  }
  const id = f?.smartLayerId
  if (id) editor.setSmartTransform(id, patch as Record<string, number>, false)
  else editor.setFloatingTransform(patch)
}

/** Точка ручки (0..7: углы чётные, середины сторон нечётные) на исходном bbox. */
function bboxHandlePoint(f: FloatingState, h: number): { x: number; y: number } {
  const xs = [f.bbox.x, f.bbox.x + f.bbox.w / 2, f.bbox.x + f.bbox.w]
  const ys = [f.bbox.y, f.bbox.y + f.bbox.h / 2, f.bbox.y + f.bbox.h]
  // 0:TL 1:T 2:TR 3:R 4:BR 5:B 6:BL 7:L
  const col = [0, 1, 2, 2, 2, 1, 0, 0][h]!
  const row = [0, 0, 0, 1, 2, 2, 2, 1][h]!
  return { x: xs[col]!, y: ys[row]! }
}

/** Границы трансформированного bbox в док-координатах при данном сдвиге. */
function floatExtent(
  f: FloatingState,
  dx: number,
  dy: number,
): { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number } {
  const pts = [
    { x: f.bbox.x, y: f.bbox.y },
    { x: f.bbox.x + f.bbox.w, y: f.bbox.y },
    { x: f.bbox.x + f.bbox.w, y: f.bbox.y + f.bbox.h },
    { x: f.bbox.x, y: f.bbox.y + f.bbox.h },
  ].map((p) => {
    const x = (p.x - f.cx) * f.sx
    const y = (p.y - f.cy) * f.sy
    const cs = Math.cos(f.rot)
    const sn = Math.sin(f.rot)
    return { x: cs * x - sn * y + f.cx + dx, y: sn * x + cs * y + f.cy + dy }
  })
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
    cx: f.cx + dx,
    cy: f.cy + dy,
  }
}

/** Прилипание сдвига: края и центр bbox → края/центр документа. */
function snapDelta(
  f: FloatingState,
  dx: number,
  dy: number,
  thr: number,
): { dx: number; dy: number } {
  const doc = useEditorStore.getState().docJson
  if (!doc) return { dx, dy }
  const ext = floatExtent(f, dx, dy)
  const xTargets = [0, doc.width / 2, doc.width]
  const yTargets = [0, doc.height / 2, doc.height]

  let bestDx = 0
  let bestAx = thr
  for (const value of [ext.x0, ext.cx, ext.x1]) {
    for (const target of xTargets) {
      const diff = target - value
      if (Math.abs(diff) < bestAx) {
        bestAx = Math.abs(diff)
        bestDx = diff
      }
    }
  }
  let bestDy = 0
  let bestAy = thr
  for (const value of [ext.y0, ext.cy, ext.y1]) {
    for (const target of yTargets) {
      const diff = target - value
      if (Math.abs(diff) < bestAy) {
        bestAy = Math.abs(diff)
        bestDy = diff
      }
    }
  }
  return { dx: dx + bestDx, dy: dy + bestDy }
}

/**
 * Прилипание масштаба при якорном масштабировании: «щелчок» на 100% +
 * подгонка k так, чтобы тянущаяся ручка легла на край/центр документа
 * (якорь pA неподвижен, движется ручка pH).
 */
function snapScaleAnchored(
  f: FloatingState,
  pA: { x: number; y: number },
  pH: { x: number; y: number },
  k: number,
  thr: number,
): number {
  // 100% исходного размера.
  if (Math.abs(f.sx * k - 1) < 0.04 && Math.abs(f.sy * k - 1) < 0.04) return 1 / f.sx
  const doc = useEditorStore.getState().docJson
  if (!doc || Math.abs(f.rot) > 0.02) return k
  // Якорная точка после текущей трансформации — она стоит на месте.
  const qA = {
    x: (pA.x - f.cx) * f.sx + f.cx + f.dx,
    y: (pA.y - f.cy) * f.sy + f.cy + f.dy,
  }
  let best = k
  let bestErr = thr
  const axes: ['x' | 'y', number, number[]][] = [
    ['x', f.sx, [0, doc.width / 2, doc.width]],
    ['y', f.sy, [0, doc.height / 2, doc.height]],
  ]
  for (const [axis, s, targets] of axes) {
    const base = (pH[axis] - pA[axis]) * s // ход ручки от якоря при k=1
    if (Math.abs(base) < 1e-3) continue // боковая ручка: поперечная ось не двигается
    const cur = qA[axis] + base * k
    for (const target of targets) {
      const err = Math.abs(cur - target)
      const kk = (target - qA[axis]) / base
      if (err < bestErr && kk > 0.02) {
        bestErr = err
        best = kk
      }
    }
  }
  return best
}

/**
 * Курсор поворота: изогнутая стрелка вокруг угла рамки, повёрнутая под
 * ближайший угол (0 = верхний левый). Кэш по углу с шагом 15°.
 */
const rotateCursorCache = new Map<number, string>()
function rotateCursor(angleDeg: number): string {
  const a = ((Math.round(angleDeg / 15) * 15) % 360 + 360) % 360
  let cur = rotateCursorCache.get(a)
  if (!cur) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      `<g transform="rotate(${a} 12 12)">` +
      '<path d="M6 12A6 6 0 0 1 12 6" fill="none" stroke="#000" stroke-width="4.2" stroke-linecap="round"/>' +
      '<path d="M6 12A6 6 0 0 1 12 6" fill="none" stroke="#fff" stroke-width="2"/>' +
      '<path d="M6 16.8L3.2 11.6H8.8Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M16.8 6L11.6 3.2V8.8Z" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>' +
      '</g></svg>'
    cur = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`
    rotateCursorCache.set(a, cur)
  }
  return cur
}

type CropRect = { x: number; y: number; w: number; h: number }

/** Ручки рамки кадрирования в css (0..7: углы чётные, середины сторон нечётные). */
function cropHandlesCss(r: CropRect): { x: number; y: number }[] {
  const v = editor.getView()
  const xs = [r.x, r.x + r.w / 2, r.x + r.w].map((x) => x * v.scale + v.panX)
  const ys = [r.y, r.y + r.h / 2, r.y + r.h].map((y) => y * v.scale + v.panY)
  const col = [0, 1, 2, 2, 2, 1, 0, 0]
  const row = [0, 0, 0, 1, 2, 2, 2, 1]
  return col.map((c, i) => ({ x: xs[c]!, y: ys[row[i]!]! }))
}

function hitCropHandle(pos: { x: number; y: number }, r: CropRect): number | null {
  const hs = cropHandlesCss(r)
  for (let i = 0; i < 8; i++) {
    if (Math.abs(hs[i]!.x - pos.x) <= 6 && Math.abs(hs[i]!.y - pos.y) <= 6) return i
  }
  return null
}

function insideCropCss(pos: { x: number; y: number }, r: CropRect): boolean {
  const v = editor.getView()
  const x = (pos.x - v.panX) / v.scale
  const y = (pos.y - v.panY) / v.scale
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

/** Канвас документа: рисование, выделения, floating-трансформация, линейки. */
export function CanvasView(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rulerHRef = useRef<HTMLCanvasElement>(null)
  const rulerVRef = useRef<HTMLCanvasElement>(null)
  const { t } = useTranslation()
  const hasDoc = useEditorStore((s) => s.docJson !== null)
  const tool = useEditorStore((s) => s.tool)

  const drag = useRef<DragState | null>(null)
  const mouse = useRef<{ x: number; y: number } | null>(null)
  const spaceHeld = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current!
    editor.attach(canvas)

    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect()
      editor.resizeDisplay(rect.width, rect.height, window.devicePixelRatio)
      const dpr = window.devicePixelRatio
      const overlay = overlayRef.current
      if (overlay) {
        overlay.width = Math.round(rect.width * dpr)
        overlay.height = Math.round(rect.height * dpr)
      }
      const rh = rulerHRef.current
      const rv = rulerVRef.current
      if (rh) {
        rh.width = Math.round(rh.clientWidth * dpr)
        rh.height = Math.round(RULER * dpr)
      }
      if (rv) {
        rv.width = Math.round(RULER * dpr)
        rv.height = Math.round(rv.clientHeight * dpr)
      }
    })
    ro.observe(canvas)

    return () => {
      ro.disconnect()
      editor.detach()
    }
  }, [])

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (
        e.code === 'Space' &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        spaceHeld.current = true
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // ── Единый overlay-цикл: линейки, курсор кисти, SAM, floating, рамки ──
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      drawRulers()
      drawOverlay()
      syncCursorPos()
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lastCursor = useRef<string>('')
  const syncCursorPos = (): void => {
    const state = useEditorStore.getState()
    let next: { x: number; y: number } | null = null
    if (mouse.current && state.docJson) {
      const p = editor.engineForIo.viewToDoc(mouse.current.x, mouse.current.y)
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      if (x >= 0 && y >= 0 && x < state.docJson.width && y < state.docJson.height) next = { x, y }
    }
    const key = next ? `${next.x},${next.y}` : ''
    if (key !== lastCursor.current) {
      lastCursor.current = key
      state.setCursorPos(next)
    }
  }

  const drawRulers = (): void => {
    const dpr = window.devicePixelRatio
    const v = editor.getView()
    const doc = useEditorStore.getState().docJson
    for (const dir of ['h', 'v'] as const) {
      const el = dir === 'h' ? rulerHRef.current : rulerVRef.current
      if (!el) continue
      const ctx = el.getContext('2d')!
      ctx.save()
      ctx.scale(dpr, dpr)
      const length = dir === 'h' ? el.width / dpr : el.height / dpr
      ctx.clearRect(0, 0, dir === 'h' ? length : RULER, dir === 'h' ? RULER : length)
      ctx.fillStyle = '#242428'
      ctx.fillRect(0, 0, dir === 'h' ? length : RULER, dir === 'h' ? RULER : length)
      if (!doc) {
        ctx.restore()
        continue
      }
      // Шаг делений: главные ~≥50 css px.
      const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
      const major = steps.find((s) => s * v.scale >= 50) ?? 5000
      const minor = major / 5
      const pan = dir === 'h' ? v.panX : v.panY
      const docLen = dir === 'h' ? doc.width : doc.height
      const from = Math.max(0, Math.floor(-pan / v.scale / minor) * minor)
      const to = Math.min(docLen, Math.ceil((length - pan) / v.scale / minor) * minor)

      ctx.strokeStyle = '#5a5a62'
      ctx.fillStyle = '#8a8a92'
      ctx.font = '9px system-ui'
      ctx.beginPath()
      for (let d = from; d <= to; d += minor) {
        const css = d * v.scale + pan
        const isMajor = d % major === 0
        const tick = isMajor ? 9 : 4
        if (dir === 'h') {
          ctx.moveTo(css + 0.5, RULER)
          ctx.lineTo(css + 0.5, RULER - tick)
          if (isMajor) ctx.fillText(String(d), css + 3, 9)
        } else {
          ctx.moveTo(RULER, css + 0.5)
          ctx.lineTo(RULER - tick, css + 0.5)
          if (isMajor) {
            ctx.save()
            ctx.translate(9, css + 3)
            ctx.rotate(-Math.PI / 2)
            ctx.fillText(String(d), -ctx.measureText(String(d)).width, 0)
            ctx.restore()
          }
        }
      }
      ctx.stroke()
      // Маркер позиции курсора.
      if (mouse.current) {
        ctx.strokeStyle = '#e8a13c'
        ctx.beginPath()
        const m = dir === 'h' ? mouse.current.x : mouse.current.y
        if (dir === 'h') {
          ctx.moveTo(m + 0.5, 0)
          ctx.lineTo(m + 0.5, RULER)
        } else {
          ctx.moveTo(0, m + 0.5)
          ctx.lineTo(RULER, m + 0.5)
        }
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  /** Углы floating-бокса в css-координатах (с учётом трансформации). */
  const floatCorners = (f: FloatingState): { x: number; y: number }[] => {
    const v = editor.getView()
    const pts = [
      { x: f.bbox.x, y: f.bbox.y },
      { x: f.bbox.x + f.bbox.w, y: f.bbox.y },
      { x: f.bbox.x + f.bbox.w, y: f.bbox.y + f.bbox.h },
      { x: f.bbox.x, y: f.bbox.y + f.bbox.h },
    ]
    return pts.map((p) => {
      let x = (p.x - f.cx) * f.sx
      let y = (p.y - f.cy) * f.sy
      const cs = Math.cos(f.rot)
      const sn = Math.sin(f.rot)
      const rx = cs * x - sn * y
      const ry = sn * x + cs * y
      x = rx + f.cx + f.dx
      y = ry + f.cy + f.dy
      return { x: x * v.scale + v.panX, y: y * v.scale + v.panY }
    })
  }

  /** Ручки: 4 угла + 4 середины сторон (css). */
  const floatHandles = (f: FloatingState): { x: number; y: number }[] => {
    const c = floatCorners(f)
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    })
    return [c[0]!, mid(c[0]!, c[1]!), c[1]!, mid(c[1]!, c[2]!), c[2]!, mid(c[2]!, c[3]!), c[3]!, mid(c[3]!, c[0]!)]
  }

  const drawOverlay = (): void => {
    const overlay = overlayRef.current
    if (!overlay) return
    const ctx = overlay.getContext('2d')!
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    const dpr = window.devicePixelRatio
    ctx.save()
    ctx.scale(dpr, dpr)

    const state = useEditorStore.getState()
    const v = editor.getView()
    const d = drag.current

    // SAM: маска-кандидат + точки.
    const sam = useSamStore.getState()
    if (sam.masks.length > 0 || sam.points.length > 0) {
      const mask = sam.masks[sam.active]
      if (mask) {
        ctx.imageSmoothingEnabled = v.scale < 1
        ctx.drawImage(mask.tinted, v.panX, v.panY, mask.tinted.width * v.scale, mask.tinted.height * v.scale)
      }
      for (const p of sam.points) {
        ctx.beginPath()
        ctx.arc(p.x * v.scale + v.panX, p.y * v.scale + v.panY, 5, 0, Math.PI * 2)
        ctx.fillStyle = p.label === 1 ? '#37c24d' : '#e04545'
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.stroke()
      }
    }

    // Превью фигур выделения при перетаскивании.
    if (
      d &&
      (d.kind === 'rect' ||
        d.kind === 'ellipse' ||
        d.kind === 'lasso' ||
        d.kind === 'sam-box' ||
        d.kind === 'text-box')
    ) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      if (d.kind === 'rect' || d.kind === 'sam-box' || d.kind === 'text-box') {
        ctx.strokeRect(d.startX, d.startY, d.lastX - d.startX, d.lastY - d.startY)
      } else if (d.kind === 'ellipse') {
        ctx.beginPath()
        ctx.ellipse(
          (d.startX + d.lastX) / 2,
          (d.startY + d.lastY) / 2,
          Math.abs(d.lastX - d.startX) / 2,
          Math.abs(d.lastY - d.startY) / 2,
          0,
          0,
          Math.PI * 2,
        )
        ctx.stroke()
      } else if (d.points.length > 1) {
        ctx.beginPath()
        ctx.moveTo(d.points[0]!.x, d.points[0]!.y)
        for (const p of d.points.slice(1)) ctx.lineTo(p.x, p.y)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Рамка кадрирования: затемнение снаружи, трети, ручки, размер.
    if (state.tool === 'crop' && state.cropRect) {
      const r = state.cropRect
      const x = r.x * v.scale + v.panX
      const y = r.y * v.scale + v.panY
      const w = r.w * v.scale
      const h = r.h * v.scale
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.beginPath()
      ctx.rect(0, 0, overlay.width / dpr, overlay.height / dpr)
      ctx.rect(x, y, w, h)
      ctx.fill('evenodd')
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.strokeRect(x, y, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.beginPath()
      for (const k of [1 / 3, 2 / 3]) {
        ctx.moveTo(x + w * k, y)
        ctx.lineTo(x + w * k, y + h)
        ctx.moveTo(x, y + h * k)
        ctx.lineTo(x + w, y + h * k)
      }
      ctx.stroke()
      for (const hp of cropHandlesCss(r)) {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(hp.x - 4, hp.y - 4, 8, 8)
        ctx.strokeRect(hp.x - 4.5, hp.y - 4.5, 9, 9)
      }
      ctx.fillStyle = '#ffffff'
      ctx.font = '11px sans-serif'
      ctx.fillText(`${r.w} × ${r.h}`, x + 4, y - 6 < 10 ? y + 14 : y - 6)
    }

    // Floating/smart: рамка с ручками (Free Transform).
    const f = getTransformBox()
    if (f) {
      const corners = floatCorners(f)
      ctx.strokeStyle = '#e8a13c'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(corners[0]!.x, corners[0]!.y)
      for (const c of corners.slice(1)) ctx.lineTo(c.x, c.y)
      ctx.closePath()
      ctx.stroke()
      for (const hpos of floatHandles(f)) {
        ctx.fillStyle = '#1b1b1f'
        ctx.strokeStyle = '#e8a13c'
        ctx.fillRect(hpos.x - 4, hpos.y - 4, 8, 8)
        ctx.strokeRect(hpos.x - 4.5, hpos.y - 4.5, 9, 9)
      }
    }

    // Рамка активного текстового слоя (пока идёт редактирование).
    const doc = state.docJson
    const active = doc?.layers.find((l) => l.id === doc.activeLayerId)
    if (active?.kind === 'text' && (state.tool === 'text' || active.text.content === '')) {
      const b = measureTextBounds(active.text)
      ctx.strokeStyle = '#6ea8e8'
      ctx.setLineDash([5, 3])
      ctx.save()
      if (active.text.rotation) {
        const cx = (b.x + b.w / 2) * v.scale + v.panX
        const cy = (b.y + b.h / 2) * v.scale + v.panY
        ctx.translate(cx, cy)
        ctx.rotate((active.text.rotation * Math.PI) / 180)
        ctx.translate(-cx, -cy)
      }
      ctx.strokeRect(
        b.x * v.scale + v.panX,
        b.y * v.scale + v.panY,
        b.w * v.scale,
        b.h * v.scale,
      )
      ctx.restore()
      ctx.setLineDash([])
    }

    // Курсор кисти/ластика/кистей выделения: контур диаметра + цвет.
    const brushLike =
      state.tool === 'brush' ||
      state.tool === 'eraser' ||
      state.tool === 'select-brush-add' ||
      state.tool === 'select-brush-sub'
    if (mouse.current && brushLike && doc && !d) {
      const r = (state.brush.size / 2) * v.scale
      const { x, y } = mouse.current
      if (state.tool === 'brush') {
        const [cr, cg, cb] = hexToRgba(state.color)
        ctx.fillStyle = `rgba(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)},0.25)`
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.beginPath()
      ctx.arc(x, y, r + 1, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.restore()
  }

  const localPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const hitFloatHandle = (pos: { x: number; y: number }, f: FloatingState): number | null => {
    const handles = floatHandles(f)
    for (let i = 0; i < handles.length; i++) {
      if (Math.hypot(handles[i]!.x - pos.x, handles[i]!.y - pos.y) < 7) return i
    }
    return null
  }

  const insideFloat = (pos: { x: number; y: number }, f: FloatingState): boolean => {
    // Приблизительно: точка внутри многоугольника углов.
    const c = floatCorners(f)
    let inside = false
    for (let i = 0, j = 3; i < 4; j = i++) {
      const a = c[i]!
      const b = c[j]!
      if (a.y > pos.y !== b.y > pos.y && pos.x < ((b.x - a.x) * (pos.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside
      }
    }
    return inside
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    canvasRef.current!.setPointerCapture(e.pointerId)
    const pos = localPos(e)
    const state = useEditorStore.getState()
    const currentTool = state.tool

    const wantPan = currentTool === 'pan' || spaceHeld.current || e.button === 1
    if (wantPan) {
      drag.current = { kind: 'pan', startX: pos.x, startY: pos.y, lastX: e.clientX, lastY: e.clientY, points: [] }
      return
    }
    if (e.button !== 0 || !state.docJson) return

    switch (currentTool) {
      case 'brush':
      case 'eraser':
        editor.beginStroke(currentTool === 'eraser' ? 'erase' : 'brush', pos.x, pos.y, e.pressure)
        break
      case 'move': {
        const f = getTransformBox()
        if (f) {
          const handle = hitFloatHandle(pos, f)
          if (handle !== null) {
            drag.current = {
              kind: handle % 2 === 0 ? 'float-scale' : 'float-scale',
              startX: pos.x,
              startY: pos.y,
              lastX: pos.x,
              lastY: pos.y,
              points: [],
              floatStart: f,
              handle,
            }
            return
          }
          if (insideFloat(pos, f)) {
            drag.current = {
              kind: 'float-move',
              startX: pos.x,
              startY: pos.y,
              lastX: pos.x,
              lastY: pos.y,
              points: [],
              floatStart: f,
            }
            return
          }
          // Рядом с углом снаружи — поворот (или Alt/Shift+драг где угодно).
          const corners = floatCorners(f)
          const nearCorner = corners.some((c) => Math.hypot(c.x - pos.x, c.y - pos.y) < 26)
          if (nearCorner || e.altKey || e.shiftKey) {
            drag.current = {
              kind: 'float-rotate',
              startX: pos.x,
              startY: pos.y,
              lastX: pos.x,
              lastY: pos.y,
              points: [],
              floatStart: f,
            }
            return
          }
          // Клик мимо: floating применяется (как в Photoshop);
          // smart/text трансформации живые — ничего не делаем.
          if (!f.smartLayerId && !f.textLayerId) editor.commitFloating()
          return
        }
        // Нет floating: поднять текущее выделение и начать перемещение.
        if (state.hasSelection && editor.liftSelection()) {
          const lifted = editor.floatingState!
          drag.current = {
            kind: 'float-move',
            startX: pos.x,
            startY: pos.y,
            lastX: pos.x,
            lastY: pos.y,
            points: [],
            floatStart: lifted,
          }
        }
        break
      }
      case 'select-rect':
      case 'select-ellipse':
        drag.current = {
          kind: currentTool === 'select-rect' ? 'rect' : 'ellipse',
          startX: pos.x,
          startY: pos.y,
          lastX: pos.x,
          lastY: pos.y,
          points: [],
        }
        break
      case 'lasso':
        drag.current = { kind: 'lasso', startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, points: [pos] }
        break
      case 'wand':
        editor.selectWandCss(pos.x, pos.y, { shiftKey: e.shiftKey, altKey: e.altKey })
        break
      case 'sam':
        drag.current = { kind: 'sam-box', startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, points: [] }
        break
      case 'select-brush-add':
        editor.beginSelectionStroke('add', pos.x, pos.y, e.pressure)
        break
      case 'select-brush-sub':
        editor.beginSelectionStroke('subtract', pos.x, pos.y, e.pressure)
        break
      case 'crop': {
        const r = state.cropRect
        if (r) {
          const handle = hitCropHandle(pos, r)
          if (handle !== null) {
            drag.current = {
              kind: 'crop-handle',
              startX: pos.x,
              startY: pos.y,
              lastX: pos.x,
              lastY: pos.y,
              points: [],
              handle,
              cropStart: { ...r },
            }
            return
          }
          if (insideCropCss(pos, r)) {
            drag.current = {
              kind: 'crop-move',
              startX: pos.x,
              startY: pos.y,
              lastX: pos.x,
              lastY: pos.y,
              points: [],
              cropStart: { ...r },
            }
            return
          }
        }
        drag.current = {
          kind: 'crop-new',
          startX: pos.x,
          startY: pos.y,
          lastX: pos.x,
          lastY: pos.y,
          points: [],
        }
        break
      }
      case 'text': {
        const active = state.docJson.layers.find((l) => l.id === state.docJson!.activeLayerId)
        if (active?.kind === 'text') {
          editor.beginTextMove(active.id)
          drag.current = {
            kind: 'text-move',
            startX: pos.x,
            startY: pos.y,
            lastX: e.clientX,
            lastY: e.clientY,
            points: [],
            textLayerId: active.id,
          }
        } else {
          // Драг = закреплённая текстовая область; клик = point text (на pointerup).
          drag.current = {
            kind: 'text-box',
            startX: pos.x,
            startY: pos.y,
            lastX: pos.x,
            lastY: pos.y,
            points: [],
          }
        }
        break
      }
    }
  }

  /** Курсоры трансформации: меняются на ручках/углах, как в Photoshop. */
  const HANDLE_CURSORS = [
    'nwse-resize',
    'ns-resize',
    'nesw-resize',
    'ew-resize',
    'nwse-resize',
    'ns-resize',
    'nesw-resize',
    'ew-resize',
  ]

  const updateMoveCursor = (pos: { x: number; y: number }): void => {
    const el = canvasRef.current
    if (!el) return
    const f = getTransformBox()
    if (!f) {
      el.style.cursor = 'move'
      return
    }
    const handle = hitFloatHandle(pos, f)
    if (handle !== null) {
      el.style.cursor = HANDLE_CURSORS[handle]!
      return
    }
    if (insideFloat(pos, f)) {
      el.style.cursor = 'move'
      return
    }
    // Рядом с углом снаружи — поворот: стрелка ориентируется по углу рамки.
    const corners = floatCorners(f)
    let nearest = -1
    let bestDist = 26
    corners.forEach((c, i) => {
      const dist = Math.hypot(c.x - pos.x, c.y - pos.y)
      if (dist < bestDist) {
        bestDist = dist
        nearest = i
      }
    })
    el.style.cursor =
      nearest >= 0 ? rotateCursor(nearest * 90 + (f.rot * 180) / Math.PI) : 'default'
  }

  /** Курсор кадрирования: ручки/внутри/снаружи. */
  const updateCropCursor = (pos: { x: number; y: number }): void => {
    const el = canvasRef.current
    if (!el) return
    const r = useEditorStore.getState().cropRect
    if (!r) {
      el.style.cursor = ''
      return
    }
    const handle = hitCropHandle(pos, r)
    if (handle !== null) {
      el.style.cursor = HANDLE_CURSORS[handle]!
      return
    }
    el.style.cursor = insideCropCss(pos, r) ? 'move' : ''
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const pos = localPos(e)
    mouse.current = pos
    const toolNow = useEditorStore.getState().tool
    if (toolNow === 'move' && !drag.current) {
      updateMoveCursor(pos)
    }
    if (toolNow === 'crop' && !drag.current) {
      updateCropCursor(pos)
    }
    const d = drag.current
    if (d) {
      if (d.kind === 'pan') {
        editor.panBy(e.clientX - d.lastX, e.clientY - d.lastY)
        d.lastX = e.clientX
        d.lastY = e.clientY
        return
      }
      if (d.kind === 'text-move' && d.textLayerId) {
        editor.moveTextLayerBy(d.textLayerId, e.clientX - d.lastX, e.clientY - d.lastY)
        d.lastX = e.clientX
        d.lastY = e.clientY
        return
      }
      if (d.kind === 'crop-new' || d.kind === 'crop-move' || d.kind === 'crop-handle') {
        const v = editor.getView()
        const toDoc = (cx: number, cy: number): { x: number; y: number } => ({
          x: (cx - v.panX) / v.scale,
          y: (cy - v.panY) / v.scale,
        })
        const setCropRect = useEditorStore.getState().setCropRect
        if (d.kind === 'crop-new') {
          const a = toDoc(d.startX, d.startY)
          const b = toDoc(pos.x, pos.y)
          setCropRect({
            x: Math.round(Math.min(a.x, b.x)),
            y: Math.round(Math.min(a.y, b.y)),
            w: Math.max(1, Math.round(Math.abs(b.x - a.x))),
            h: Math.max(1, Math.round(Math.abs(b.y - a.y))),
          })
        } else if (d.kind === 'crop-move' && d.cropStart) {
          setCropRect({
            ...d.cropStart,
            x: Math.round(d.cropStart.x + (pos.x - d.startX) / v.scale),
            y: Math.round(d.cropStart.y + (pos.y - d.startY) / v.scale),
          })
        } else if (d.cropStart && d.handle !== undefined) {
          const s0 = d.cropStart
          const dxDoc = (pos.x - d.startX) / v.scale
          const dyDoc = (pos.y - d.startY) / v.scale
          let x0 = s0.x
          let y0 = s0.y
          let x1 = s0.x + s0.w
          let y1 = s0.y + s0.h
          const col = [0, 1, 2, 2, 2, 1, 0, 0][d.handle]!
          const row = [0, 0, 0, 1, 2, 2, 2, 1][d.handle]!
          if (col === 0) x0 += dxDoc
          if (col === 2) x1 += dxDoc
          if (row === 0) y0 += dyDoc
          if (row === 2) y1 += dyDoc
          setCropRect({
            x: Math.round(Math.min(x0, x1)),
            y: Math.round(Math.min(y0, y1)),
            w: Math.max(1, Math.round(Math.abs(x1 - x0))),
            h: Math.max(1, Math.round(Math.abs(y1 - y0))),
          })
        }
        d.lastX = pos.x
        d.lastY = pos.y
        return
      }
      if (d.kind === 'float-move' && d.floatStart) {
        const v = editor.getView()
        let dx = d.floatStart.dx + (pos.x - d.startX) / v.scale
        let dy = d.floatStart.dy + (pos.y - d.startY) / v.scale
        // Прилипание к краям и центру документа (Alt отключает).
        if (!e.altKey) {
          const snapped = snapDelta(d.floatStart, dx, dy, 8 / v.scale)
          dx = snapped.dx
          dy = snapped.dy
        }
        applyTransformPatch(d, { dx, dy })
        return
      }
      if (d.kind === 'float-scale' && d.floatStart) {
        const f = d.floatStart
        const v = editor.getView()
        const h = d.handle ?? 0
        // Якорь — противоположная ручка (как в Photoshop): объект растёт в
        // сторону той ручки, за которую тянем, а противоположная стоит.
        const pA = bboxHandlePoint(f, (h + 4) % 8)
        const cs = Math.cos(f.rot)
        const sn = Math.sin(f.rot)
        const rel = { x: pA.x - f.cx, y: pA.y - f.cy }
        const anchorAt = (sx: number, sy: number): { x: number; y: number } => ({
          x: cs * rel.x * sx - sn * rel.y * sy,
          y: sn * rel.x * sx + cs * rel.y * sy,
        })
        const a0 = anchorAt(f.sx, f.sy)
        const aCss = {
          x: (a0.x + f.cx + f.dx) * v.scale + v.panX,
          y: (a0.y + f.cy + f.dy) * v.scale + v.panY,
        }
        // Масштаб — проекция курсора на ось «якорь → точка захвата»:
        // движение поперёк оси ручку не раздувает.
        const d0 = Math.max(4, Math.hypot(d.startX - aCss.x, d.startY - aCss.y))
        const ux = (d.startX - aCss.x) / d0
        const uy = (d.startY - aCss.y) / d0
        let k = ((pos.x - aCss.x) * ux + (pos.y - aCss.y) * uy) / d0
        // Прилипание: ручка к краям/центру дока + «щелчок» на 100% (Alt — откл.).
        if (!e.altKey) k = snapScaleAnchored(f, pA, bboxHandlePoint(f, h), k, 8 / v.scale)
        k = Math.max(0.02, k)

        if (f.textLayerId) {
          // Текст растёт от своего якоря (левый верх): держим противоположную
          // ручку на месте сдвигом. Поворот текста здесь игнорируем.
          applyTransformPatch(d, {
            sx: k,
            sy: k,
            dx: (pA.x - f.bbox.x) * (1 - k),
            dy: (pA.y - f.bbox.y) * (1 - k),
          })
          return
        }

        // Углы — пропорционально; боковые ручки — по одной оси.
        let nsx = f.sx
        let nsy = f.sy
        if (h % 2 === 1) {
          if (h === 1 || h === 5) nsy = Math.max(0.02, f.sy * k)
          else nsx = Math.max(0.02, f.sx * k)
        } else {
          nsx = Math.max(0.02, f.sx * k)
          nsy = Math.max(0.02, f.sy * k)
        }
        // Компенсация сдвига: якорная точка остаётся неподвижной.
        const a1 = anchorAt(nsx, nsy)
        applyTransformPatch(d, {
          sx: nsx,
          sy: nsy,
          dx: f.dx + (a0.x - a1.x),
          dy: f.dy + (a0.y - a1.y),
        })
        return
      }
      if (d.kind === 'float-rotate' && d.floatStart) {
        const f = d.floatStart
        const v = editor.getView()
        const cCss = { x: (f.cx + f.dx) * v.scale + v.panX, y: (f.cy + f.dy) * v.scale + v.panY }
        const a0 = Math.atan2(d.startY - cCss.y, d.startX - cCss.x)
        const a1 = Math.atan2(pos.y - cCss.y, pos.x - cCss.x)
        let rot = f.rot + (a1 - a0)
        // Прилипание к ключевым углам (кратно 45°), Alt отключает.
        if (!e.altKey) {
          const deg = (rot * 180) / Math.PI
          const nearest = Math.round(deg / 45) * 45
          if (Math.abs(deg - nearest) < 4) rot = (nearest * Math.PI) / 180
        }
        applyTransformPatch(d, { rot })
        return
      }
      d.lastX = pos.x
      d.lastY = pos.y
      if (d.kind === 'lasso') d.points.push(pos)
      return
    }

    if (!editor.isStroking) return
    const rect = canvasRef.current!.getBoundingClientRect()
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
    for (const ev of events) {
      editor.strokeTo(ev.clientX - rect.left, ev.clientY - rect.top, ev.pressure)
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    const d = drag.current
    drag.current = null

    if (d) {
      const mods = { shiftKey: e.shiftKey, altKey: e.altKey }
      if (d.kind === 'rect') editor.selectRectCss(d.startX, d.startY, d.lastX, d.lastY, mods)
      if (d.kind === 'ellipse') editor.selectEllipseCss(d.startX, d.startY, d.lastX, d.lastY, mods)
      if (d.kind === 'lasso') {
        if (d.points.length >= 3) editor.selectPolygonCss(d.points, mods)
        else editor.deselect() // клик лассо — снять выделение
      }
      if (d.kind === 'text-move' && d.textLayerId) editor.commitTextMove(d.textLayerId)
      if (
        (d.kind === 'float-move' || d.kind === 'float-scale' || d.kind === 'float-rotate') &&
        d.floatStart?.textLayerId &&
        d.floatStart.textBase
      ) {
        const id = d.floatStart.textLayerId
        const base = d.floatStart.textBase
        const doc = useEditorStore.getState().docJson
        const cur = doc?.layers.find((l) => l.id === id)
        if (cur?.kind === 'text') {
          editor.commitTextChange(
            id,
            {
              x: base.x,
              y: base.y,
              fontSize: base.fontSize,
              rotation: base.rotation,
              ...(base.boxW !== undefined ? { boxW: base.boxW } : {}),
              ...(base.boxH !== undefined ? { boxH: base.boxH } : {}),
            },
            {
              x: cur.text.x,
              y: cur.text.y,
              fontSize: cur.text.fontSize,
              rotation: cur.text.rotation ?? 0,
              ...(cur.text.boxW !== undefined ? { boxW: cur.text.boxW } : {}),
              ...(cur.text.boxH !== undefined ? { boxH: cur.text.boxH } : {}),
            },
          )
        }
      }
      if (
        (d.kind === 'float-move' || d.kind === 'float-scale' || d.kind === 'float-rotate') &&
        d.floatStart?.smartLayerId
      ) {
        const id = d.floatStart.smartLayerId
        const cur = editor.getSmartInfo(id)?.transform
        if (cur) {
          const b = d.floatStart
          editor.commitSmartTransform(
            id,
            { dx: b.dx, dy: b.dy, sx: b.sx, sy: b.sy, rot: b.rot },
            { dx: cur.dx, dy: cur.dy, sx: cur.sx, sy: cur.sy, rot: cur.rot },
          )
        }
      }
      if (d.kind === 'text-box') {
        const moved = Math.hypot(d.lastX - d.startX, d.lastY - d.startY)
        if (moved < 6) {
          editor.addTextLayerAt(d.startX, d.startY)
        } else {
          editor.addTextLayerAt(Math.min(d.startX, d.lastX), Math.min(d.startY, d.lastY), {
            w: Math.abs(d.lastX - d.startX),
            h: Math.abs(d.lastY - d.startY),
          })
        }
      }
      if (d.kind === 'crop-new') {
        // Клик без растягивания — убрать рамку.
        const moved = Math.hypot(d.lastX - d.startX, d.lastY - d.startY)
        if (moved < 4) useEditorStore.getState().setCropRect(null)
      }
      if (d.kind === 'sam-box') {
        const engine = editor.engineForIo
        const moved = Math.hypot(d.lastX - d.startX, d.lastY - d.startY)
        if (moved < 4) {
          const p = engine.viewToDoc(d.startX, d.startY)
          void samAddPoint(p.x, p.y, e.altKey ? 0 : 1)
        } else {
          const a = engine.viewToDoc(Math.min(d.startX, d.lastX), Math.min(d.startY, d.lastY))
          const b = engine.viewToDoc(Math.max(d.startX, d.lastX), Math.max(d.startY, d.lastY))
          void samSetBox([a.x, a.y, b.x, b.y])
        }
      }
      return
    }
    editor.endStroke()
  }

  const onWheel = (e: React.WheelEvent): void => {
    const pos = localPos(e)
    editor.zoomAt(pos.x, pos.y, e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  const onDoubleClick = (): void => {
    if (editor.floatingState) editor.commitFloating()
    const s = useEditorStore.getState()
    if (s.tool === 'crop' && s.cropRect) applyCrop()
  }

  // Сброс императивного курсора при смене инструмента.
  useEffect(() => {
    if (canvasRef.current && tool !== 'move' && tool !== 'crop') {
      canvasRef.current.style.cursor = ''
    }
  }, [tool])

  // Move-инструмент: обычный растровый слой конвертируется в smart на лету —
  // любой слой (фон, созданный, вставленный) таскается рамкой без потерь.
  const activeLayerId = useEditorStore((s) => s.docJson?.activeLayerId ?? null)
  const hasSelectionNow = useEditorStore((s) => s.hasSelection)
  useEffect(() => {
    if (tool !== 'move' || !activeLayerId || hasSelectionNow) return
    const doc = useEditorStore.getState().docJson
    const layer = doc?.layers.find((l) => l.id === activeLayerId)
    if (layer?.kind === 'raster' && !layer.smart && !editor.floatingState) {
      editor.convertToSmart(activeLayerId)
    }
  }, [tool, activeLayerId, hasSelectionNow])

  const cursor =
    tool === 'pan'
      ? 'grab'
      : tool === 'move'
        ? 'move'
        : tool === 'text'
          ? 'text'
          : tool === 'brush' ||
              tool === 'eraser' ||
              tool === 'select-brush-add' ||
              tool === 'select-brush-sub'
            ? 'none'
            : hasDoc
              ? 'crosshair'
              : 'default'

  return (
    <div className="canvas-wrap">
      <div className="ruler-corner" />
      <canvas ref={rulerHRef} className="ruler ruler-h" />
      <canvas ref={rulerVRef} className="ruler ruler-v" />
      <div className="canvas-area">
        <canvas
          ref={canvasRef}
          className="doc-canvas"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            mouse.current = null
          }}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => {
            e.preventDefault()
            // ПКМ по точке SAM — удалить её.
            if (useEditorStore.getState().tool === 'sam') {
              const pos = localPos(e)
              const engine = editor.engineForIo
              const p = engine.viewToDoc(pos.x, pos.y)
              void samRemovePointNear(p.x, p.y, 10 / editor.getView().scale)
            }
          }}
        />
        <canvas ref={overlayRef} className="overlay-canvas" />
        {!hasDoc && <span className="canvas-hint">{t('app.emptyCanvasHint')}</span>}
      </div>
    </div>
  )
}

// samSessionActive используется хоткеями в App.
export { samSessionActive }
