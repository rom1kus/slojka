import type { TextParams, TextStyleRange } from '@slojka/shared'

/**
 * Растеризация текстового слоя в RGBA-буфер размера документа.
 * Canvas2D: многострочность, трекинг, межстрочный интервал, выравнивание,
 * стили фрагментов (свой шрифт/начертание/размер/цвет у части текста).
 * Возвращает НЕпремультиплицированные пиксели (getImageData) — загрузка
 * в текстуру идёт с UNPACK_PREMULTIPLY_ALPHA_WEBGL.
 */
function cssFamily(family: string): string {
  return family.includes(' ') ? `"${family}"` : family
}

/** Ставит шрифт сегмента: базовые параметры + переопределения фрагмента. */
function applyFont(
  ctx: OffscreenCanvasRenderingContext2D,
  params: TextParams,
  style?: TextStyleRange,
): void {
  const fs = style?.fontStyle ?? params.fontStyle
  const size = style?.fontSize ?? params.fontSize
  const family = cssFamily(style?.fontFamily ?? params.fontFamily)
  ctx.font = `${fs} ${size}px ${family}`
}

function setupCtx(ctx: OffscreenCanvasRenderingContext2D, params: TextParams): void {
  applyFont(ctx, params)
  if (params.letterSpacing !== 0) ctx.letterSpacing = `${params.letterSpacing}px`
}

/** Строка вывода + смещение её первого символа в content (для styleRanges). */
interface Line {
  text: string
  start: number
}

/** Кусок строки с единым стилем. */
interface Segment {
  text: string
  style?: TextStyleRange
}

/** Разрезает подстроку content[startIdx..] на однородные по стилю куски. */
function segmentsOf(text: string, startIdx: number, params: TextParams): Segment[] {
  const len = text.length
  const ranges = (params.styleRanges ?? [])
    .map((r) => ({ ...r, start: Math.max(0, r.start - startIdx), end: Math.min(len, r.end - startIdx) }))
    .filter((r) => r.start < r.end)
    .sort((a, b) => a.start - b.start)
  if (!ranges.length) return [{ text }]
  const out: Segment[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start) })
    out.push({ text: text.slice(r.start, r.end), style: r })
    pos = r.end
  }
  if (pos < len) out.push({ text: text.slice(pos) })
  return out
}

/** Ширина куска текста с учётом стилей фрагментов (letterSpacing уже на ctx). */
function measureRun(
  ctx: OffscreenCanvasRenderingContext2D,
  params: TextParams,
  text: string,
  startIdx: number,
): number {
  let w = 0
  for (const seg of segmentsOf(text, startIdx, params)) {
    applyFont(ctx, params, seg.style)
    w += ctx.measureText(seg.text).width
  }
  return w
}

/** Разбивка контента на строки: явные \n + перенос по словам в ширину боксa. */
function layoutLines(
  ctx: OffscreenCanvasRenderingContext2D,
  params: TextParams,
): Line[] {
  const out: Line[] = []
  let offset = 0
  for (const line of params.content.split('\n')) {
    if (!params.boxW) {
      out.push({ text: line, start: offset })
    } else {
      let cur = ''
      let curStart = offset
      let wordPos = offset
      for (const word of line.split(' ')) {
        const probe = cur ? `${cur} ${word}` : word
        if (cur && measureRun(ctx, params, probe, curStart) > params.boxW) {
          out.push({ text: cur, start: curStart })
          cur = word
          curStart = wordPos
        } else {
          cur = probe
        }
        wordPos += word.length + 1
      }
      out.push({ text: cur, start: curStart })
    }
    offset += line.length + 1
  }
  return out
}

/** Наибольший размер шрифта среди базового и фрагментов (для высоты рамки). */
function maxFontSize(params: TextParams): number {
  return Math.max(params.fontSize, ...(params.styleRanges ?? []).map((r) => r.fontSize ?? 0))
}

/** Ограничивающий прямоугольник текста (для рамки в UI). */
export function measureTextBounds(
  params: TextParams,
): { x: number; y: number; w: number; h: number } {
  if (params.boxW && params.boxH) {
    return { x: params.x, y: params.y, w: params.boxW, h: params.boxH }
  }
  const canvas = new OffscreenCanvas(1, 1)
  const ctx = canvas.getContext('2d')!
  setupCtx(ctx, params)
  const lines = params.content.split('\n')
  let off = 0
  const widths = lines.map((l) => {
    const w = measureRun(ctx, params, l, off)
    off += l.length + 1
    return w
  })
  const maxWidth = Math.max(8, ...widths)
  const big = maxFontSize(params)
  const height = Math.max(
    big * 1.2,
    params.fontSize * params.lineHeight * (lines.length - 1) + big * 1.2,
  )
  return { x: params.x, y: params.y, w: maxWidth, h: height }
}

export function rasterizeText(params: TextParams, docW: number, docH: number): ImageData {
  const canvas = new OffscreenCanvas(docW, docH)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas2D недоступен')

  setupCtx(ctx, params)
  ctx.textBaseline = 'alphabetic'

  // Поворот вокруг центра рамки текста.
  if (params.rotation) {
    const b = measureTextBounds(params)
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    ctx.translate(cx, cy)
    ctx.rotate((params.rotation * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }

  const lines = layoutLines(ctx, params)
  const lineStep = params.fontSize * params.lineHeight
  // Первая базовая линия ~ на высоте шрифта от якоря (фрагменты крупнее —
  // выравниваются по той же базовой линии, как в Photoshop).
  const baseY = params.y + params.fontSize

  const widths = lines.map((l) => measureRun(ctx, params, l.text, l.start))
  const refWidth = params.boxW ?? Math.max(0, ...widths)

  lines.forEach((line, i) => {
    if (!line.text) return
    const y = baseY + i * lineStep
    // Paragraph text: клип по высоте области.
    if (params.boxH && y - params.fontSize > params.y + params.boxH) return
    let x = params.x
    if (params.align === 'center') x = params.x + (refWidth - widths[i]!) / 2
    if (params.align === 'right') x = params.x + (refWidth - widths[i]!)
    for (const seg of segmentsOf(line.text, line.start, params)) {
      applyFont(ctx, params, seg.style)
      ctx.fillStyle = seg.style?.color ?? params.color
      ctx.fillText(seg.text, x, y)
      x += ctx.measureText(seg.text).width
    }
  })

  return ctx.getImageData(0, 0, docW, docH)
}
