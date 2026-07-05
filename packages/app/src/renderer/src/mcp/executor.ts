import { editor, hexToRgba } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import { loadSlojka, saveSlojka } from '../io/slojkaFormat'
import { importOra } from '../io/ora'
import { importPsd } from '../io/psd'
import { exportComposite, formatFromPath } from '../io/exporters'
import { unpremultiply } from '../io/pixels'
import { insertResult } from '../io/polzaOps'
import { samReset } from '../tools/samTool'
import type { SelectionOp } from '@slojka/engine'
import { DEFAULT_TEXT_PARAMS } from '@slojka/shared'

type ToolArgs = Record<string, unknown>

/** Пиксельные операции требуют растровый активный слой — иначе понятная ошибка. */
function requireRasterActive(): void {
  const doc = editor.engineForIo.getDocumentJson()
  if (!doc) throw new Error('Нет открытого документа')
  const active = doc.layers.find((l) => l.id === doc.activeLayerId)
  if (!active) throw new Error('Нет активного слоя')
  if (active.kind !== 'raster') {
    throw new Error(
      `Активный слой «${active.name}» — текстовый; выберите растровый слой (set_active_layer)`,
    )
  }
}

/**
 * Исполнитель MCP-инструментов: все правки идут через тот же
 * command/history-пайплайн, что и UI — действия Claude отменяемы Ctrl+Z.
 */
const handlers: Record<string, (args: ToolArgs) => Promise<unknown> | unknown> = {
  get_document_info() {
    const doc = editor.engineForIo.getDocumentJson()
    if (!doc) return { open: false }
    return {
      open: true,
      width: doc.width,
      height: doc.height,
      layerCount: doc.layers.length,
      activeLayerId: doc.activeLayerId,
      hasSelection: editor.engineForIo.hasSelection,
      file: useEditorStore.getState().fileName,
    }
  },

  new_document(a) {
    samReset()
    editor.newDocument(
      Number(a['width']),
      Number(a['height']),
      (a['background'] as 'white' | 'transparent') ?? 'white',
    )
    return { ok: true }
  },

  async open_project(a) {
    samReset()
    const path = String(a['path'])
    const data = new Uint8Array(await window.slojka.readFile(path))
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    if (ext === 'slojka') await loadSlojka(data, editor.engineForIo)
    else if (ext === 'ora') await importOra(data, editor.engineForIo)
    else if (ext === 'psd') await importPsd(data.buffer as ArrayBuffer, editor.engineForIo)
    else {
      const bmp = await createImageBitmap(new Blob([data as BlobPart]))
      editor.engineForIo.importImageAsDocument(bmp)
    }
    const name = path.split('/').pop() ?? path
    useEditorStore.getState().setFileInfo(ext === 'slojka' ? path : null, name, ext !== 'slojka')
    editor.zoomFit()
    return { ok: true, name }
  },

  async save_project(a) {
    const store = useEditorStore.getState()
    let path = (a['path'] as string | undefined) ?? store.filePath
    if (!path) throw new Error('Файл ещё не сохранялся — укажите path')
    if (!path.endsWith('.slojka')) path += '.slojka'
    const zip = await saveSlojka(editor.engineForIo)
    await window.slojka.writeFile(path, toAb(zip))
    store.setFileInfo(path, path.split('/').pop() ?? path, false)
    return { ok: true, path }
  },

  async export_image(a) {
    const path = String(a['path'])
    const data = await exportComposite(editor.engineForIo, formatFromPath(path))
    await window.slojka.writeFile(path, toAb(data))
    return { ok: true, path }
  },

  async get_canvas_png(a) {
    const scale = Number(a['scale'] ?? 0.5)
    const { pixels, width, height } = editor.engineForIo.readComposite()
    const full = new OffscreenCanvas(width, height)
    full.getContext('2d')!.putImageData(new ImageData(unpremultiply(pixels), width, height), 0, 0)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const small = new OffscreenCanvas(w, h)
    small.getContext('2d')!.drawImage(full, 0, 0, w, h)
    const blob = await small.convertToBlob({ type: 'image/png' })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return { __image: btoa(s) }
  },

  list_layers() {
    return editor.engineForIo.getDocumentJson()?.layers ?? []
  },

  create_layer(a) {
    return { id: editor.engineForIo.addLayer(String(a['name'] ?? 'Слой')) }
  },

  delete_layer(a) {
    editor.engineForIo.deleteLayer(String(a['id']))
    return { ok: true }
  },

  set_active_layer(a) {
    editor.engineForIo.setActiveLayer(String(a['id']))
    return { ok: true }
  },

  set_layer_props(a) {
    const { id, ...patch } = a as { id: string } & Record<string, unknown>
    editor.engineForIo.setLayerProps(String(id), patch)
    return { ok: true }
  },

  add_text_layer(a) {
    const id = editor.engineForIo.addTextLayer(String(a['content']).slice(0, 24) || 'Текст', {
      ...DEFAULT_TEXT_PARAMS,
      content: String(a['content']),
      x: Number(a['x']),
      y: Number(a['y']),
      fontSize: Number(a['fontSize'] ?? 48),
      color: String(a['color'] ?? '#1e1e1e'),
      fontFamily: String(a['fontFamily'] ?? 'sans-serif'),
    })
    return { id }
  },

  flatten_image() {
    editor.engineForIo.flattenImage()
    return { ok: true }
  },

  select_rect(a) {
    editor.engineForIo.selectRect(
      Number(a['x']),
      Number(a['y']),
      Number(a['width']),
      Number(a['height']),
      (a['op'] as SelectionOp) ?? 'replace',
    )
    return { ok: true }
  },

  select_all() {
    editor.engineForIo.selectAll()
    return { ok: true }
  },

  deselect() {
    editor.engineForIo.deselect()
    return { ok: true }
  },

  invert_selection() {
    editor.engineForIo.invertSelection()
    return { ok: true }
  },

  feather_selection(a) {
    editor.engineForIo.featherSelection(Number(a['radius']))
    return { ok: true }
  },

  async sam_select(a) {
    const points = a['points'] as { x: number; y: number; label: number }[]
    const engine = editor.engineForIo
    const doc = engine.getDocumentJson()
    if (!doc) throw new Error('Нет документа')
    // set-image + predict через main-прокси; маска → выделение.
    const { pixels, width, height } = engine.readComposite()
    const { pixelsToPng, pngToMask } = await import('../io/pixels')
    const png = await pixelsToPng(pixels, width, height)
    let s = ''
    for (let i = 0; i < png.length; i += 0x8000) {
      s += String.fromCharCode(...png.subarray(i, i + 0x8000))
    }
    await window.slojka.aiSamSetImage(btoa(s))
    const res = await window.slojka.aiSamPredict({ points })
    const best = res.masks[0]
    if (!best) throw new Error('SAM не вернул маску')
    const maskBytes = Uint8Array.from(atob(best.png_base64), (c) => c.charCodeAt(0))
    const r8 = await pngToMask(maskBytes, doc.width, doc.height)
    engine.selectFromMask(r8, 'replace')
    return { ok: true, score: best.score }
  },

  fill_selection(a) {
    requireRasterActive()
    editor.engineForIo.fillSelectedArea(hexToRgba(String(a['color'])))
    return { ok: true }
  },

  clear_selection_area() {
    requireRasterActive()
    editor.engineForIo.clearSelectedArea()
    return { ok: true }
  },

  brush_stroke(a) {
    requireRasterActive()
    const engine = editor.engineForIo
    const points = a['points'] as { x: number; y: number }[]
    const brush = {
      size: Number(a['size'] ?? 24),
      hardness: Number(a['hardness'] ?? 0.8),
      opacity: Number(a['opacity'] ?? 1),
      flow: 1,
      spacing: 0.12,
      pressureSize: false,
      pressureFlow: false,
    }
    engine.beginStroke(
      a['erase'] ? 'erase' : 'brush',
      brush,
      hexToRgba(String(a['color'] ?? '#1e1e1e')),
      { x: points[0]!.x, y: points[0]!.y, pressure: 0.5 },
    )
    for (const p of points.slice(1)) engine.strokeTo({ x: p.x, y: p.y, pressure: 0.5 })
    engine.endStroke()
    return { ok: true }
  },

  undo() {
    editor.undo()
    return { ok: true }
  },

  redo() {
    editor.redo()
    return { ok: true }
  },

  async polza_generate(a) {
    const job = await window.slojka.polzaGenerate({
      kind: 'generate',
      model: String(a['model']),
      input: {
        prompt: String(a['prompt']),
        aspect_ratio: String(a['aspect_ratio'] ?? '1:1'),
        max_images: Number(a['max_images'] ?? 1),
      },
    })
    return { id: job.id, status: job.status }
  },

  async polza_job_status(a) {
    const { jobs } = await window.slojka.polzaJobs()
    const job = jobs.find((j) => j.id === a['id'])
    if (!job) throw new Error('Задача не найдена')
    return {
      id: job.id,
      status: job.status,
      error: job.error,
      cost_rub: job.cost_rub,
      results: job.result_files.length,
    }
  },

  async polza_insert_result(a) {
    await insertResult(String(a['id']), Number(a['index'] ?? 0))
    return { ok: true }
  },
}

export function registerMcpExecutor(): void {
  window.slojka.onMcpCall((id, tool, args) => {
    void (async () => {
      try {
        const handler = handlers[tool]
        if (!handler) throw new Error(`Неизвестный инструмент: ${tool}`)
        const result = await handler((args ?? {}) as ToolArgs)
        window.slojka.mcpResult(id, result, null)
      } catch (e) {
        window.slojka.mcpResult(id, null, e instanceof Error ? e.message : String(e))
      }
    })()
  })
}

function toAb(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}
