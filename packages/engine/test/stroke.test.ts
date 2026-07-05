import { describe, expect, it } from 'vitest'
import { StrokeLayout } from '../src/brush/stroke'
import { DEFAULT_BRUSH, type BrushParams } from '../src/brush/types'

const brush: BrushParams = {
  ...DEFAULT_BRUSH,
  size: 10,
  spacing: 0.2, // шаг 2px
  pressureSize: false,
  pressureFlow: false,
}

describe('StrokeLayout', () => {
  it('ставит первый даб в точке касания', () => {
    const layout = new StrokeLayout(brush, 0)
    const dabs = layout.start({ x: 5, y: 5, pressure: 1 })
    expect(dabs).toHaveLength(1)
    expect(dabs[0]).toMatchObject({ x: 5, y: 5, size: 10 })
  })

  it('раскладывает дабы с шагом spacing*size', () => {
    const layout = new StrokeLayout(brush, 0)
    layout.start({ x: 0, y: 0, pressure: 1 })
    const dabs = layout.extend({ x: 10, y: 0, pressure: 1 })
    // 10px / 2px шаг = 5 дабов (на 2,4,6,8,10)
    expect(dabs).toHaveLength(5)
    expect(dabs.map((d) => Math.round(d.x))).toEqual([2, 4, 6, 8, 10])
    expect(dabs.every((d) => d.y === 0)).toBe(true)
  })

  it('переносит остаток дистанции между сегментами', () => {
    const layout = new StrokeLayout(brush, 0)
    layout.start({ x: 0, y: 0, pressure: 1 })
    const first = layout.extend({ x: 1.5, y: 0, pressure: 1 }) // меньше шага
    expect(first).toHaveLength(0)
    const second = layout.extend({ x: 3, y: 0, pressure: 1 })
    expect(second).toHaveLength(1)
    expect(second[0]!.x).toBeCloseTo(2, 5)
  })

  it('масштабирует размер по нажиму', () => {
    const layout = new StrokeLayout({ ...brush, pressureSize: true }, 0)
    const dabs = layout.start({ x: 0, y: 0, pressure: 0.5 })
    expect(dabs[0]!.size).toBe(5)
  })

  it('не выдаёт дабы при нулевом перемещении', () => {
    const layout = new StrokeLayout(brush, 0)
    layout.start({ x: 5, y: 5, pressure: 1 })
    expect(layout.extend({ x: 5, y: 5, pressure: 1 })).toHaveLength(0)
  })
})
