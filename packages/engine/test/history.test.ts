import { describe, expect, it } from 'vitest'
import { History, PixelPatch, type Command } from '../src/history/history'

function cmd(label: string, log: string[], bytes = 100): Command {
  return {
    label,
    bytes,
    undo: () => log.push(`undo:${label}`),
    redo: () => log.push(`redo:${label}`),
  }
}

describe('History', () => {
  it('undo/redo в правильном порядке', () => {
    const log: string[] = []
    const h = new History()
    h.push(cmd('a', log))
    h.push(cmd('b', log))

    expect(h.undoLabel).toBe('b')
    h.undo()
    h.undo()
    expect(log).toEqual(['undo:b', 'undo:a'])
    expect(h.canUndo).toBe(false)

    h.redo()
    expect(log).toEqual(['undo:b', 'undo:a', 'redo:a'])
    expect(h.redoLabel).toBe('b')
  })

  it('новая команда очищает redo-стек', () => {
    const log: string[] = []
    const h = new History()
    h.push(cmd('a', log))
    h.undo()
    h.push(cmd('b', log))
    expect(h.canRedo).toBe(false)
  })

  it('вытесняет старые записи по бюджету памяти', () => {
    const log: string[] = []
    const disposed: string[] = []
    const h = new History(250, 100)
    for (const name of ['a', 'b', 'c']) {
      h.push({ ...cmd(name, log), dispose: () => disposed.push(name) })
    }
    // 3×100 байт > 250 — «a» должна быть вытеснена.
    expect(disposed).toEqual(['a'])
    h.undo()
    h.undo()
    expect(h.canUndo).toBe(false)
    expect(log).toEqual(['undo:c', 'undo:b'])
  })

  it('вытесняет по числу записей', () => {
    const h = new History(Infinity, 2)
    const log: string[] = []
    h.push(cmd('a', log))
    h.push(cmd('b', log))
    h.push(cmd('c', log))
    h.undo()
    h.undo()
    expect(h.canUndo).toBe(false)
  })
})

describe('PixelPatch', () => {
  it('сжимает и распаковывает без потерь', () => {
    const raw = new Uint8Array(64 * 64 * 4)
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256
    const patch = new PixelPatch({ x: 1, y: 2, w: 64, h: 64 }, raw)
    expect(patch.bytes).toBeLessThan(raw.byteLength)
    expect(patch.unpack()).toEqual(raw)
    expect(patch.rect).toEqual({ x: 1, y: 2, w: 64, h: 64 })
  })
})
