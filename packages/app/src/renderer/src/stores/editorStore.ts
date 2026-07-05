import { create } from 'zustand'
import type { DocumentJson } from '@slojka/shared'
import { DEFAULT_BRUSH, type BrushParams, type SelectionOp } from '@slojka/engine'
import type { BrushPreset } from '../io/brushes'

export type Tool =
  | 'brush'
  | 'eraser'
  | 'pan'
  | 'move'
  | 'select-rect'
  | 'select-ellipse'
  | 'lasso'
  | 'wand'
  | 'sam'
  | 'select-brush-add'
  | 'select-brush-sub'
  | 'text'
  | 'crop'

interface EngineSnapshot {
  docJson: DocumentJson | null
  canUndo: boolean
  canRedo: boolean
  zoom: number
  hasSelection: boolean
  maskEditLayerId: string | null
  historyLabels: { undo: string[]; redo: string[] }
  layerThumbs: Record<string, string>
}

interface EditorState extends EngineSnapshot {
  tool: Tool
  brush: BrushParams
  /** #rrggbb */
  color: string
  selectionOp: SelectionOp
  wandTolerance: number
  glRenderer: string
  glSoftware: boolean
  newDocOpen: boolean
  featherOpen: boolean
  canvasSizeOpen: boolean
  /** Рамка кадрирования в док-координатах (инструмент «Кадрирование»). */
  cropRect: { x: number; y: number; w: number; h: number } | null
  /** Пиксель документа под курсором (для статусбара). */
  cursorPos: { x: number; y: number } | null
  /** Мультивыбор слоёв (Ctrl+клик в панели). */
  selectedLayerIds: string[]
  /** Файл проекта. */
  filePath: string | null
  fileName: string | null
  dirty: boolean
  toast: string | null
  /** Библиотека кистей. */
  presets: BrushPreset[]
  activePresetId: string

  setTool: (tool: Tool) => void
  setBrush: (patch: Partial<BrushParams>) => void
  setColor: (color: string) => void
  setSelectionOp: (op: SelectionOp) => void
  setWandTolerance: (v: number) => void
  setNewDocOpen: (open: boolean) => void
  setFeatherOpen: (open: boolean) => void
  setCanvasSizeOpen: (open: boolean) => void
  setCropRect: (r: { x: number; y: number; w: number; h: number } | null) => void
  setCursorPos: (p: { x: number; y: number } | null) => void
  setSelectedLayerIds: (ids: string[]) => void
  setFileInfo: (path: string | null, name: string | null, dirty: boolean) => void
  setDirty: (dirty: boolean) => void
  setToast: (msg: string | null) => void
  setPresets: (presets: BrushPreset[]) => void
  applyPreset: (id: string) => void
  syncFromEngine: (snap: EngineSnapshot) => void
  setGlInfo: (renderer: string, software: boolean) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  docJson: null,
  canUndo: false,
  canRedo: false,
  zoom: 1,
  hasSelection: false,
  maskEditLayerId: null,
  historyLabels: { undo: [], redo: [] },
  layerThumbs: {},
  tool: 'brush',
  brush: { ...DEFAULT_BRUSH },
  color: '#1e1e1e',
  selectionOp: 'replace',
  wandTolerance: 32,
  glRenderer: '',
  glSoftware: false,
  newDocOpen: false,
  featherOpen: false,
  canvasSizeOpen: false,
  cropRect: null,
  cursorPos: null,
  selectedLayerIds: [],
  filePath: null,
  fileName: null,
  dirty: false,
  toast: null,
  presets: [],
  activePresetId: 'builtin-round',

  setTool: (tool) => set({ tool }),
  setBrush: (patch) => set((s) => ({ brush: { ...s.brush, ...patch } })),
  setColor: (color) => set({ color }),
  setSelectionOp: (selectionOp) => set({ selectionOp }),
  setWandTolerance: (wandTolerance) => set({ wandTolerance }),
  setNewDocOpen: (newDocOpen) => set({ newDocOpen }),
  setFeatherOpen: (featherOpen) => set({ featherOpen }),
  setCanvasSizeOpen: (canvasSizeOpen) => set({ canvasSizeOpen }),
  setCropRect: (cropRect) => set({ cropRect }),
  setCursorPos: (cursorPos) => set({ cursorPos }),
  setSelectedLayerIds: (selectedLayerIds) => set({ selectedLayerIds }),
  setFileInfo: (filePath, fileName, dirty) => set({ filePath, fileName, dirty }),
  setDirty: (dirty) => set({ dirty }),
  setToast: (toast) => set({ toast }),
  setPresets: (presets) => set({ presets }),
  applyPreset: (id) =>
    set((s) => {
      const preset = s.presets.find((p) => p.id === id)
      if (!preset) return {}
      return { activePresetId: id, brush: { ...preset.params } }
    }),
  syncFromEngine: (snap) => set(snap),
  setGlInfo: (glRenderer, glSoftware) => set({ glRenderer, glSoftware }),
}))
