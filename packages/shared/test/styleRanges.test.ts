import { describe, expect, it } from 'vitest'
import { adjustStyleRanges, setStyleRange, type TextStyleRange } from '../src/document'

describe('setStyleRange', () => {
  it('создаёт диапазон и режет пересечения', () => {
    let r = setStyleRange(undefined, 0, 5, { color: '#ff0000' })
    expect(r).toEqual([{ start: 0, end: 5, color: '#ff0000' }])
    r = setStyleRange(r, 2, 3, { color: '#00ff00' })
    expect(r).toEqual([
      { start: 0, end: 2, color: '#ff0000' },
      { start: 2, end: 3, color: '#00ff00' },
      { start: 3, end: 5, color: '#ff0000' },
    ])
  })

  it('накладывает patch поверх существующих свойств', () => {
    let r = setStyleRange(undefined, 0, 4, { color: '#ff0000' })
    r = setStyleRange(r, 2, 6, { fontSize: 60 })
    expect(r).toEqual([
      { start: 0, end: 2, color: '#ff0000' },
      { start: 2, end: 4, color: '#ff0000', fontSize: 60 },
      { start: 4, end: 6, fontSize: 60 },
    ])
  })

  it('сливает соседние одинаковые и снимает стили при patch=null', () => {
    let r = setStyleRange(undefined, 0, 2, { color: '#ff0000' })
    r = setStyleRange(r, 2, 4, { color: '#ff0000' })
    expect(r).toEqual([{ start: 0, end: 4, color: '#ff0000' }])
    r = setStyleRange(r, 1, 3, null)
    expect(r).toEqual([
      { start: 0, end: 1, color: '#ff0000' },
      { start: 3, end: 4, color: '#ff0000' },
    ])
  })
})

describe('adjustStyleRanges', () => {
  const ranges: TextStyleRange[] = [{ start: 2, end: 5, color: '#ff0000' }]

  it('сдвигает диапазон при вставке до него', () => {
    expect(adjustStyleRanges(ranges, 'abcdef', 'XYabcdef')).toEqual([
      { start: 4, end: 7, color: '#ff0000' },
    ])
  })

  it('расширяет диапазон при наборе внутри него', () => {
    expect(adjustStyleRanges(ranges, 'abcdef', 'abcXdef')).toEqual([
      { start: 2, end: 6, color: '#ff0000' },
    ])
  })

  it('обрезает диапазон при удалении его части и убирает пустой', () => {
    expect(adjustStyleRanges(ranges, 'abcdef', 'abef')).toEqual([
      { start: 2, end: 3, color: '#ff0000' },
    ])
    expect(adjustStyleRanges(ranges, 'abcdef', 'af')).toEqual([])
  })
})
