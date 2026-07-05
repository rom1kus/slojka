import { BRAND } from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { loadSlojka, saveSlojka } from './slojkaFormat'
import { importOra, exportOra } from './ora'
import { importPsd } from './psd'
import { exportComposite, formatFromPath } from './exporters'
import { createTab, snapshotCurrent, updateActiveTab } from './tabs'

function store() {
  return useEditorStore.getState()
}

function toast(msg: string): void {
  store().setToast(msg)
}

/** Открыть: .slojka / .ora / .psd / картинки. */
export async function openDocument(): Promise<void> {
  const file = await window.slojka.openDocumentDialog()
  if (!file) return
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const bytes = new Uint8Array(file.data)

  try {
    // Текущая работа НЕ теряется: она уезжает в свою вкладку.
    await snapshotCurrent()
    createTab(file.name)
    if (ext === BRAND.fileExt.slice(1)) {
      await loadSlojka(bytes, editor.engineForIo)
      store().setFileInfo(file.path, file.name, false)
    } else if (ext === 'ora') {
      await importOra(bytes, editor.engineForIo)
      store().setFileInfo(null, file.name, true)
    } else if (ext === 'psd') {
      const { report } = await importPsd(file.data, editor.engineForIo)
      store().setFileInfo(null, file.name, true)
      if (report.degraded.length > 0) {
        toast(`PSD: ${report.imported} слоёв; упрощено: ${report.degraded.length}`)
        console.info('PSD import report:', report)
      }
    } else {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
      editor.engineForIo.importImageAsDocument(bmp)
      store().setFileInfo(null, file.name, true)
    }
    editor.zoomFit()
  } catch (e) {
    console.error(e)
    toast(`Не удалось открыть: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Импорт картинки: нижним слоем текущего холста (или новым документом).
 * Как «Поместить» в Photoshop: большая картинка вписывается целиком,
 * и сразу открывается рамка трансформации — двигай/масштабируй, Enter.
 */
export async function importImageFile(): Promise<void> {
  const file = await window.slojka.openImageDialog()
  if (!file) return
  try {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(file.data) as BlobPart]))
    const engine = editor.engineForIo
    if (engine.hasDocument) {
      const id = engine.addImageLayer(bmp, file.name, 'bottom')
      if (id) {
        engine.setActiveLayer(id)
        // Smart-слой: рамка трансформации живая, без потерь качества.
        useEditorStore.getState().setTool('move')
        toast('Картинка вставлена smart-слоем: двигайте и масштабируйте без потерь')
        return
      }
      toast(`Импортировано нижним слоем: ${file.name}`)
    } else {
      engine.importImageAsDocument(bmp)
      store().setFileInfo(null, file.name, true)
      editor.zoomFit()
    }
  } catch (e) {
    console.error(e)
    toast(`Не удалось импортировать: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Сохранить проект (.slojka). */
export async function saveDocument(saveAs: boolean): Promise<void> {
  if (!editor.engineForIo.hasDocument) return
  const s = store()
  let path = saveAs ? null : s.filePath
  if (!path) {
    const suggested = (s.fileName?.replace(/\.[^.]+$/, '') ?? 'untitled') + BRAND.fileExt
    path = await window.slojka.saveDialog('project', suggested)
    if (!path) return
    if (!path.endsWith(BRAND.fileExt)) path += BRAND.fileExt
  }
  try {
    const zip = await saveSlojka(editor.engineForIo)
    await window.slojka.writeFile(path, toArrayBuffer(zip))
    const name = path.split('/').pop() ?? path
    store().setFileInfo(path, name, false)
    updateActiveTab({ name, filePath: path, dirty: false })
    void window.slojka.autosaveClear()
    toast(`Сохранено: ${name}`)
  } catch (e) {
    console.error(e)
    toast(`Ошибка сохранения: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Экспорт PNG/JPEG/WebP/ORA. */
export async function exportDocument(): Promise<void> {
  if (!editor.engineForIo.hasDocument) return
  const s = store()
  const base = s.fileName?.replace(/\.[^.]+$/, '') ?? 'export'
  const path = await window.slojka.saveDialog('export', `${base}.png`)
  if (!path) return
  try {
    const data = path.toLowerCase().endsWith('.ora')
      ? await exportOra(editor.engineForIo)
      : await exportComposite(editor.engineForIo, formatFromPath(path))
    await window.slojka.writeFile(path, toArrayBuffer(data))
    toast(`Экспортировано: ${path.split('/').pop()}`)
  } catch (e) {
    console.error(e)
    toast(`Ошибка экспорта: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

// ── Автосохранение ──

let autosaveTimer: ReturnType<typeof setInterval> | null = null
let autosaving = false

/** Автосейв раз в 60с, если есть несохранённые изменения. */
export function startAutosave(): void {
  if (autosaveTimer) return
  autosaveTimer = setInterval(() => {
    void (async () => {
      const s = store()
      if (autosaving || !s.dirty || !s.docJson) return
      autosaving = true
      try {
        const zip = await saveSlojka(editor.engineForIo)
        await window.slojka.autosaveWrite(toArrayBuffer(zip))
      } catch (e) {
        console.warn('Автосохранение не удалось', e)
      } finally {
        autosaving = false
      }
    })()
  }, 60_000)
}

/** Проверка восстановления при старте. Возвращает true, если есть что восстановить. */
export async function checkRecovery(): Promise<boolean> {
  return window.slojka.autosaveCheck()
}

export async function recoverAutosave(): Promise<void> {
  try {
    const data = await window.slojka.autosaveRead()
    await loadSlojka(new Uint8Array(data), editor.engineForIo)
    store().setFileInfo(null, 'восстановлено', true)
    editor.zoomFit()
    toast('Документ восстановлен из автосохранения')
  } catch (e) {
    toast(`Не удалось восстановить: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await window.slojka.autosaveClear()
  }
}

export async function discardAutosave(): Promise<void> {
  await window.slojka.autosaveClear()
}
