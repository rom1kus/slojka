/**
 * CPU-растеризация фигур выделения в одноканальный буфер (антиалиасинг
 * даёт Canvas2D). Вызывается только на коммите фигуры — не в горячем пути.
 */

export type SelectionOp = 'replace' | 'add' | 'subtract' | 'intersect'

export interface Point {
  x: number
  y: number
}

function makeCanvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas2D недоступен')
  ctx.fillStyle = '#fff'
  return ctx
}

function alphaChannel(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const img = ctx.getImageData(0, 0, w, h)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4 + 3]!
  return out
}

export function rasterRect(
  docW: number,
  docH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8Array {
  const ctx = makeCanvas(docW, docH)
  ctx.fillRect(x, y, w, h)
  return alphaChannel(ctx, docW, docH)
}

export function rasterEllipse(
  docW: number,
  docH: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Uint8Array {
  const ctx = makeCanvas(docW, docH)
  ctx.beginPath()
  ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2)
  ctx.fill()
  return alphaChannel(ctx, docW, docH)
}

export function rasterPolygon(docW: number, docH: number, points: Point[]): Uint8Array {
  const ctx = makeCanvas(docW, docH)
  if (points.length >= 3) {
    ctx.beginPath()
    ctx.moveTo(points[0]!.x, points[0]!.y)
    for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    ctx.fill()
  }
  return alphaChannel(ctx, docW, docH)
}

/**
 * Волшебная палочка: flood fill по композиту с допуском по RGB-расстоянию.
 * pixels — RGBA композита (premult не мешает: сравниваем как есть).
 */
export function magicWand(
  pixels: Uint8Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  tolerance: number,
): Uint8Array {
  const out = new Uint8Array(w * h)
  const sx = Math.round(seedX)
  const sy = Math.round(seedY)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out

  const idx = (sy * w + sx) * 4
  const sr = pixels[idx]!
  const sg = pixels[idx + 1]!
  const sb = pixels[idx + 2]!
  const sa = pixels[idx + 3]!
  const tol2 = tolerance * tolerance * 4 // на 4 канала

  const stack: number[] = [sy * w + sx]
  const visited = new Uint8Array(w * h)
  visited[sy * w + sx] = 1

  while (stack.length > 0) {
    const p = stack.pop()!
    const i4 = p * 4
    const dr = pixels[i4]! - sr
    const dg = pixels[i4 + 1]! - sg
    const db = pixels[i4 + 2]! - sb
    const da = pixels[i4 + 3]! - sa
    if (dr * dr + dg * dg + db * db + da * da > tol2) continue

    out[p] = 255
    const x = p % w
    const y = (p / w) | 0
    if (x > 0 && !visited[p - 1]) (visited[p - 1] = 1), stack.push(p - 1)
    if (x < w - 1 && !visited[p + 1]) (visited[p + 1] = 1), stack.push(p + 1)
    if (y > 0 && !visited[p - w]) (visited[p - w] = 1), stack.push(p - w)
    if (y < h - 1 && !visited[p + w]) (visited[p + w] = 1), stack.push(p + w)
  }
  return out
}
