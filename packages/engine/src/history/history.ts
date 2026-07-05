import { deflateSync, inflateSync } from 'fflate'

export interface Command {
  /** Ключ для i18n в UI ("history.brushStroke"). */
  label: string
  undo(): void
  redo(): void
  /** Оценка занимаемой памяти в байтах (для бюджета). */
  bytes: number
  dispose?(): void
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Сжатый снапшот пикселей области — общий кирпич пиксельных команд. */
export class PixelPatch {
  private data: Uint8Array
  readonly rect: Rect

  constructor(rect: Rect, rawPixels: Uint8Array) {
    this.rect = rect
    this.data = deflateSync(rawPixels, { level: 3 })
  }

  unpack(): Uint8Array {
    return inflateSync(this.data)
  }

  get bytes(): number {
    return this.data.byteLength
  }
}

/**
 * Кольцевая история с бюджетом памяти: при переполнении старейшие
 * записи выбрасываются (насовсем — «дно» истории поднимается).
 */
export class History {
  private undoStack: Command[] = []
  private redoStack: Command[] = []

  constructor(
    private budgetBytes = 256 * 1024 * 1024,
    private maxEntries = 200,
    private onChange?: () => void,
  ) {}

  /** Сменить бюджет памяти на лету (настройка пользователя). */
  setBudget(bytes: number): void {
    this.budgetBytes = Math.max(32 * 1024 * 1024, bytes)
    this.evict()
    this.onChange?.()
  }

  push(cmd: Command): void {
    this.undoStack.push(cmd)
    for (const c of this.redoStack) c.dispose?.()
    this.redoStack = []
    this.evict()
    this.onChange?.()
  }

  undo(): boolean {
    const cmd = this.undoStack.pop()
    if (!cmd) return false
    cmd.undo()
    this.redoStack.push(cmd)
    this.onChange?.()
    return true
  }

  redo(): boolean {
    const cmd = this.redoStack.pop()
    if (!cmd) return false
    cmd.redo()
    this.undoStack.push(cmd)
    this.onChange?.()
    return true
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  /** Метки undo-стека снизу вверх (старые → новые). */
  allUndoLabels(): string[] {
    return this.undoStack.map((c) => c.label)
  }

  /** Метки redo-стека в порядке применения (следующий redo — первый). */
  allRedoLabels(): string[] {
    return [...this.redoStack].reverse().map((c) => c.label)
  }

  get totalBytes(): number {
    let sum = 0
    for (const c of this.undoStack) sum += c.bytes
    for (const c of this.redoStack) sum += c.bytes
    return sum
  }

  clear(): void {
    for (const c of this.undoStack) c.dispose?.()
    for (const c of this.redoStack) c.dispose?.()
    this.undoStack = []
    this.redoStack = []
    this.onChange?.()
  }

  private evict(): void {
    while (
      this.undoStack.length > this.maxEntries ||
      (this.totalBytes > this.budgetBytes && this.undoStack.length > 1)
    ) {
      const dropped = this.undoStack.shift()
      if (!dropped) break
      dropped.dispose?.()
    }
  }
}
