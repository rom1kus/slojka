import { create } from 'zustand'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { samReset } from '../tools/samTool'
import { loadSlojka, saveSlojka } from './slojkaFormat'

/**
 * Вкладки документов: открытие файла больше НЕ затирает текущую работу.
 * Неактивные документы живут снапшотами .slojka в памяти; переключение =
 * снапшот текущего + загрузка целевого. История правок — на активный
 * документ (при переключении она начинается заново).
 */

export interface DocTab {
  id: string
  name: string
  filePath: string | null
  dirty: boolean
  snapshot: Uint8Array | null
}

interface TabsState {
  tabs: DocTab[]
  activeId: string | null
  set: (patch: Partial<TabsState>) => void
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeId: null,
  set: (patch) => set(patch),
}))

function toast(msg: string): void {
  useEditorStore.getState().setToast(msg)
}

/** Снапшот активного документа в его вкладку (перед переключением). */
export async function snapshotCurrent(): Promise<void> {
  const { tabs, activeId, set } = useTabsStore.getState()
  if (!activeId || !editor.engineForIo.hasDocument) return
  const snapshot = await saveSlojka(editor.engineForIo)
  const editorState = useEditorStore.getState()
  set({
    tabs: tabs.map((t) =>
      t.id === activeId
        ? {
            ...t,
            snapshot,
            dirty: editorState.dirty,
            name: editorState.fileName ?? t.name,
            filePath: editorState.filePath,
          }
        : t,
    ),
  })
}

/** Новая вкладка (документ создаёт/загружает вызывающий код). */
export function createTab(name: string, filePath: string | null = null): string {
  const id = crypto.randomUUID()
  const { tabs, set } = useTabsStore.getState()
  set({ tabs: [...tabs, { id, name, filePath, dirty: false, snapshot: null }], activeId: id })
  // Незавершённая SAM-сессия и рамка кадрирования принадлежали прежнему документу.
  samReset()
  useEditorStore.getState().setCropRect(null)
  return id
}

/** Обновить метаданные активной вкладки (после сохранения/загрузки). */
export function updateActiveTab(patch: Partial<Pick<DocTab, 'name' | 'filePath' | 'dirty'>>): void {
  const { tabs, activeId, set } = useTabsStore.getState()
  if (!activeId) return
  set({ tabs: tabs.map((t) => (t.id === activeId ? { ...t, ...patch } : t)) })
}

export async function switchTab(id: string): Promise<void> {
  const state = useTabsStore.getState()
  if (id === state.activeId) return
  const target = state.tabs.find((t) => t.id === id)
  if (!target) return

  await snapshotCurrent()
  samReset()
  useEditorStore.getState().setCropRect(null)
  useTabsStore.getState().set({ activeId: id })
  if (target.snapshot) {
    await loadSlojka(target.snapshot, editor.engineForIo)
  }
  useEditorStore.getState().setFileInfo(target.filePath, target.name, target.dirty)
  useEditorStore.getState().setSelectedLayerIds([])
  editor.zoomFit()
}

export async function closeTab(id: string): Promise<void> {
  const state = useTabsStore.getState()
  const target = state.tabs.find((t) => t.id === id)
  if (!target) return
  const isActive = id === state.activeId
  const isDirty = isActive ? useEditorStore.getState().dirty : target.dirty
  if (isDirty && !window.confirm(`«${target.name}»: есть несохранённые изменения. Закрыть?`)) {
    return
  }

  const rest = state.tabs.filter((t) => t.id !== id)
  useTabsStore.getState().set({ tabs: rest })
  if (isActive) {
    samReset()
    useEditorStore.getState().setCropRect(null)
    const next = rest.at(-1)
    if (next) {
      useTabsStore.getState().set({ activeId: next.id })
      if (next.snapshot) await loadSlojka(next.snapshot, editor.engineForIo)
      useEditorStore.getState().setFileInfo(next.filePath, next.name, next.dirty)
      editor.zoomFit()
    } else {
      useTabsStore.getState().set({ activeId: null })
      editor.engineForIo.closeDocument()
      useEditorStore.getState().setFileInfo(null, null, false)
    }
  }
}

/** Перенос слоя на другую вкладку (drag-n-drop строки слоя на вкладку). */
export async function copyLayerToTab(layerId: string, tabId: string): Promise<void> {
  const engine = editor.engineForIo
  const doc = engine.getDocumentJson()
  const layer = doc?.layers.find((l) => l.id === layerId)
  if (!doc || !layer) return
  if (tabId === useTabsStore.getState().activeId) return

  const pixels = engine.readLayerPixels(layerId) ?? undefined
  const mask = layer.hasMask ? (engine.readMaskPixels(layerId) ?? undefined) : undefined
  const source =
    layer.kind === 'raster' && layer.smart
      ? (engine.readSourcePixels(layerId)?.pixels ?? undefined)
      : undefined

  await switchTab(tabId)
  editor.engineForIo.insertSerializedLayer(structuredClone(layer), {
    ...(pixels ? { pixels } : {}),
    ...(mask ? { mask } : {}),
    ...(source ? { source } : {}),
  })
  toast(`Слой «${layer.name}» скопирован во вкладку`)
}
