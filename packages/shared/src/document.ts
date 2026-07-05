/**
 * JSON-модель документа. Пиксели живут в движке (текстуры),
 * модель хранит структуру и параметры. Сериализуется в manifest.json
 * формата .slojka как есть.
 */

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'soft-light',
  'darken',
  'lighten',
  'add',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export interface ShadowStyle {
  enabled: boolean
  /** #rrggbb */
  color: string
  /** 0..1 */
  opacity: number
  /** Смещение в px документа. */
  distance: number
  /** Угол в градусах (0 = вправо, 90 = вниз). */
  angle: number
  /** Радиус размытия, px. */
  size: number
  /** Расширение (дилатация до размытия), px: тень плотнеет и растёт. */
  spread?: number
}

export interface GlowStyle {
  enabled: boolean
  /** #rrggbb */
  color: string
  /** 0..1 */
  opacity: number
  /** Радиус свечения, px. */
  size: number
  /** Расширение (дилатация до размытия), px: ореол плотнеет и растёт. */
  spread?: number
}

export interface BlurStyle {
  enabled: boolean
  /** Радиус гаусса, px (0..100). */
  radius: number
}

export interface MotionBlurStyle {
  enabled: boolean
  /** Длина смаза, px (0..300). */
  distance: number
  /** Угол в градусах (0 = вправо, 90 = вниз). */
  angle: number
}

export interface ColorOverlayStyle {
  enabled: boolean
  /** #rrggbb */
  color: string
  /** 0..1 */
  opacity: number
}

export interface LayerStyles {
  dropShadow?: ShadowStyle
  innerShadow?: ShadowStyle
  outerGlow?: GlowStyle
  colorOverlay?: ColorOverlayStyle
  gaussianBlur?: BlurStyle
  motionBlur?: MotionBlurStyle
}

export const DEFAULT_SHADOW: ShadowStyle = {
  enabled: true,
  color: '#000000',
  opacity: 0.5,
  distance: 8,
  angle: 45,
  size: 12,
}

export const DEFAULT_GLOW: GlowStyle = {
  enabled: true,
  color: '#ffd86b',
  opacity: 0.65,
  size: 16,
}

export const DEFAULT_COLOR_OVERLAY: ColorOverlayStyle = {
  enabled: true,
  color: '#e04040',
  opacity: 1,
}

export const DEFAULT_GAUSSIAN_BLUR: BlurStyle = {
  enabled: true,
  radius: 8,
}

export const DEFAULT_MOTION_BLUR: MotionBlurStyle = {
  enabled: true,
  distance: 30,
  angle: 0,
}

interface LayerBase {
  id: string
  name: string
  visible: boolean
  /** 0..1 */
  opacity: number
  blendMode: BlendMode
  /** Обтравочная маска: слой клипится альфой ближайшего не-clipped слоя ниже. */
  clipped: boolean
  /** Есть ли растровая маска слоя (пиксели — в движке/файле). */
  hasMask: boolean
  /** Стили слоя (тени). Отсутствие = стилей нет. */
  styles?: LayerStyles
}

/** Трансформация smart-слоя (оригинал → холст). */
export interface SmartTransform {
  /** Центр размещения в док-координатах. */
  cx: number
  cy: number
  dx: number
  dy: number
  sx: number
  sy: number
  /** Радианы. */
  rot: number
}

export interface RasterLayerJson extends LayerBase {
  kind: 'raster'
  /**
   * Smart-слой (как Smart Object в PS): пиксели рендерятся из оригинала
   * полного разрешения с этой трансформацией — масштабирование и
   * перемещение без потерь, «за краем холста» ничего не пропадает.
   * Оригинал хранится в движке/файле (data/source-<id>.png).
   */
  smart?: {
    srcW: number
    srcH: number
    transform: SmartTransform
  }
}

export type TextAlign = 'left' | 'center' | 'right'

/**
 * Стиль фрагмента текста (как выделение символов в Photoshop): индексы по
 * content, полуинтервал [start, end). Заданные поля перекрывают базовые
 * параметры слоя, отсутствующие — наследуются.
 */
export interface TextStyleRange {
  start: number
  end: number
  /** #rrggbb */
  color?: string
  fontFamily?: string
  /** Как TextParams.fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic'. */
  fontStyle?: string
  fontSize?: number
}

export type TextStylePatch = Partial<Omit<TextStyleRange, 'start' | 'end'>>

const hasProps = (r: TextStyleRange): boolean =>
  r.color !== undefined ||
  r.fontFamily !== undefined ||
  r.fontStyle !== undefined ||
  r.fontSize !== undefined

const sameProps = (a: TextStyleRange, b: TextStyleRange): boolean =>
  a.color === b.color &&
  a.fontFamily === b.fontFamily &&
  a.fontStyle === b.fontStyle &&
  a.fontSize === b.fontSize

/**
 * Применяет patch к фрагменту [start, end): существующие диапазоны режутся
 * по границам, внутри интервала patch накладывается поверх их свойств,
 * в «дырах» создаются новые диапазоны. patch = null снимает все переопределения
 * с фрагмента. Соседние диапазоны с одинаковыми свойствами сливаются.
 */
export function setStyleRange(
  ranges: TextStyleRange[] | undefined,
  start: number,
  end: number,
  patch: TextStylePatch | null,
): TextStyleRange[] {
  const out: TextStyleRange[] = []
  const covered: TextStyleRange[] = []
  for (const r of ranges ?? []) {
    if (r.end <= start || r.start >= end) {
      out.push({ ...r })
      continue
    }
    if (r.start < start) out.push({ ...r, end: start })
    if (r.end > end) out.push({ ...r, start: end })
    covered.push({ ...r, start: Math.max(r.start, start), end: Math.min(r.end, end) })
  }
  if (patch) {
    covered.sort((a, b) => a.start - b.start)
    let pos = start
    for (const piece of covered) {
      if (piece.start > pos) out.push({ start: pos, end: piece.start, ...patch })
      out.push({ ...piece, ...patch })
      pos = piece.end
    }
    if (pos < end) out.push({ start: pos, end, ...patch })
  }
  out.sort((a, b) => a.start - b.start)
  const merged: TextStyleRange[] = []
  for (const r of out) {
    if (!hasProps(r) || r.end <= r.start) continue
    const last = merged[merged.length - 1]
    if (last && last.end >= r.start && sameProps(last, r)) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/**
 * Пересчёт диапазонов после правки текста: находит общий префикс/суффикс
 * (зона замены), сдвигает границы за ней и прижимает попавшие внутрь.
 * Набор внутри стилизованного фрагмента расширяет его.
 */
export function adjustStyleRanges(
  ranges: TextStyleRange[],
  oldText: string,
  newText: string,
): TextStyleRange[] {
  if (oldText === newText) return ranges
  let p = 0
  const maxP = Math.min(oldText.length, newText.length)
  while (p < maxP && oldText[p] === newText[p]) p++
  let s = 0
  while (s < maxP - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++
  const removed = oldText.length - s - p
  const inserted = newText.length - s - p
  const mapIdx = (i: number): number =>
    i <= p ? i : i >= p + removed ? i + inserted - removed : p + Math.min(inserted, i - p)
  const out: TextStyleRange[] = []
  for (const r of ranges) {
    const start = mapIdx(r.start)
    const end = mapIdx(r.end)
    if (end > start) out.push({ ...r, start, end })
  }
  return out
}

export interface TextParams {
  content: string
  fontFamily: string
  /** CSS font-style/weight строка: 'normal', 'bold', 'italic', 'bold italic'. */
  fontStyle: string
  /** px документа. */
  fontSize: number
  /** #rrggbb */
  color: string
  /** Дополнительный трекинг, px. */
  letterSpacing: number
  /** Множитель межстрочного интервала. */
  lineHeight: number
  align: TextAlign
  /** Стили фрагментов текста поверх базовых параметров (не пересекаются). */
  styleRanges?: TextStyleRange[]
  /** Позиция якоря текста в документе (левый верх первой строки). */
  x: number
  y: number
  /**
   * Фиксированная область (paragraph text, как в Photoshop): текст
   * переносится по ширине и клипится по высоте; рамка не «сжимается».
   * Отсутствие = point text (рамка по содержимому).
   */
  boxW?: number
  boxH?: number
  /** Поворот текста в градусах (вокруг центра рамки). */
  rotation?: number
}

export interface TextLayerJson extends LayerBase {
  kind: 'text'
  text: TextParams
}

export type LayerJson = RasterLayerJson | TextLayerJson

export interface DocumentJson {
  schema: 1
  width: number
  height: number
  /** layers[0] — нижний слой. */
  layers: LayerJson[]
  activeLayerId: string | null
}

export const CANVAS_LIMITS = {
  min: 1,
  max: 8192,
  warn: 4096,
  defaultWidth: 2048,
  defaultHeight: 2048,
} as const

export const DEFAULT_TEXT_PARAMS: Omit<TextParams, 'x' | 'y'> = {
  content: '',
  fontFamily: 'sans-serif',
  fontStyle: 'normal',
  fontSize: 48,
  color: '#1e1e1e',
  letterSpacing: 0,
  lineHeight: 1.2,
  align: 'left',
}

export function newLayerId(): string {
  return globalThis.crypto.randomUUID()
}
