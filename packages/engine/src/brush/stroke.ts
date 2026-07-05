import type { BrushParams, Dab, StrokePoint } from './types'

/**
 * Раскладка мазков вдоль штриха: интерполяция входных точек с шагом
 * spacing*size, перенос остатка дистанции между сегментами, сглаживание входа.
 * Чистая математика — покрыта юнит-тестами.
 */
export class StrokeLayout {
  private last: StrokePoint | null = null
  /** Дистанция, «не дотянувшая» до следующего даба на прошлом сегменте. */
  private carry = 0
  private smoothed: StrokePoint | null = null

  constructor(
    private brush: BrushParams,
    /** 0..1, доля сглаживания входных точек (0 — выключено). */
    private smoothing = 0.35,
  ) {}

  /** Первый даб ставится сразу в точке касания. */
  start(p: StrokePoint): Dab[] {
    this.smoothed = { ...p }
    this.last = { ...p }
    this.carry = 0
    return [this.makeDab(p)]
  }

  /** Дабы для отрезка от предыдущей точки до p (может вернуть пустой массив). */
  extend(raw: StrokePoint): Dab[] {
    if (!this.last || !this.smoothed) return this.start(raw)

    const s = this.smoothing
    const p: StrokePoint = {
      x: this.smoothed.x + (raw.x - this.smoothed.x) * (1 - s),
      y: this.smoothed.y + (raw.y - this.smoothed.y) * (1 - s),
      pressure: this.smoothed.pressure + (raw.pressure - this.smoothed.pressure) * (1 - s),
    }
    this.smoothed = p

    const from = this.last
    const dx = p.x - from.x
    const dy = p.y - from.y
    const dist = Math.hypot(dx, dy)
    if (dist === 0) return []

    const step = this.stepFor(from.pressure)
    const dabs: Dab[] = []
    let travelled = this.carry === 0 ? step : this.carry

    while (travelled <= dist) {
      const t = travelled / dist
      dabs.push(
        this.makeDab({
          x: from.x + dx * t,
          y: from.y + dy * t,
          pressure: from.pressure + (p.pressure - from.pressure) * t,
        }),
      )
      travelled += this.stepFor(from.pressure + (p.pressure - from.pressure) * t)
    }

    this.carry = travelled - dist
    this.last = p
    return dabs
  }

  private stepFor(pressure: number): number {
    const size = this.sizeFor(pressure)
    return Math.max(this.brush.spacing * size, 0.5)
  }

  private sizeFor(pressure: number): number {
    return this.brush.pressureSize
      ? Math.max(this.brush.size * pressure, 1)
      : this.brush.size
  }

  private makeDab(p: StrokePoint): Dab {
    return {
      x: p.x,
      y: p.y,
      size: this.sizeFor(p.pressure),
      flow: this.brush.pressureFlow ? this.brush.flow * p.pressure : this.brush.flow,
    }
  }
}
