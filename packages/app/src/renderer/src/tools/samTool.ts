import { create } from 'zustand'
import type { SelectionOp } from '@slojka/engine'
import { editor } from '../controller/EditorController'
import { bytesToBase64, pixelsToPng, pngToMask } from '../io/pixels'
import { useEditorStore } from '../stores/editorStore'

export interface SamPoint {
  x: number
  y: number
  label: 0 | 1
}

interface SamToolState {
  points: SamPoint[]
  box: [number, number, number, number] | null
  /** Кандидаты-маски (тонированные для оверлея) + исходные PNG. */
  masks: { score: number; png: Uint8Array; tinted: ImageBitmap }[]
  active: number
  busy: boolean
  error: string | null
}

export const useSamStore = create<SamToolState>(() => ({
  points: [],
  box: null,
  masks: [],
  active: 0,
  busy: false,
  error: null,
}))

export function samSessionActive(): boolean {
  const s = useSamStore.getState()
  return s.points.length > 0 || s.box !== null
}

export function samReset(): void {
  useSamStore.setState({ points: [], box: null, masks: [], active: 0, busy: false, error: null })
}

export async function samAddPoint(docX: number, docY: number, label: 0 | 1): Promise<void> {
  console.log('[sam] addPoint', Math.round(docX), Math.round(docY), 'label', label)
  const points = [...useSamStore.getState().points, { x: docX, y: docY, label }]
  useSamStore.setState({ points })
  await samRun()
}

export async function samSetBox(box: [number, number, number, number]): Promise<void> {
  useSamStore.setState({ box })
  await samRun()
}

/** Удаление точки правой кнопкой (радиус попадания в док-координатах). */
export async function samRemovePointNear(docX: number, docY: number, radius: number): Promise<boolean> {
  const s = useSamStore.getState()
  const idx = s.points.findIndex((p) => Math.hypot(p.x - docX, p.y - docY) <= radius)
  if (idx < 0) return false
  const points = s.points.filter((_, i) => i !== idx)
  if (points.length === 0 && !s.box) {
    samReset()
    return true
  }
  useSamStore.setState({ points })
  await samRun()
  return true
}

export function samCycleMask(): void {
  const s = useSamStore.getState()
  if (s.masks.length > 1) {
    useSamStore.setState({ active: (s.active + 1) % s.masks.length })
  }
}

async function samRun(): Promise<void> {
  console.log('[sam] run start')
  const state = useSamStore.getState()
  if (state.busy) return
  useSamStore.setState({ busy: true, error: null })
  try {
    // 1. Отдаём текущий композит (кэшируется по хэшу на стороне sidecar).
    const { pixels, width, height } = editor.engineForIo.readComposite()
    const png = await pixelsToPng(pixels, width, height)
    await window.slojka.aiSamSetImage(await bytesToBase64(png))

    // 2. Предсказание.
    const s = useSamStore.getState()
    const res = await window.slojka.aiSamPredict({
      points: s.points,
      ...(s.box ? { box: s.box } : {}),
    })

    const masks = await Promise.all(
      res.masks.map(async (m) => {
        const bytes = base64ToU8(m.png_base64)
        return { score: m.score, png: bytes, tinted: await tintMask(bytes) }
      }),
    )
    console.log('[sam] run done, masks:', masks.length)
    useSamStore.setState({ masks, active: 0, busy: false })
  } catch (e) {
    useSamStore.setState({
      busy: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/** Принять маску: в выделение (с учётом режима) или как маску активного слоя. */
export async function samCommit(target: 'selection' | 'layer-mask'): Promise<void> {
  console.log('[sam] commit', target)
  try {
    const s = useSamStore.getState()
    const mask = s.masks[s.active]
    if (!mask) {
      useEditorStore.getState().setToast('SAM: маска ещё не готова — кликните по объекту')
      return
    }
    const engine = editor.engineForIo
    const doc = engine.getDocumentJson()
    if (!doc) return

    const r8 = await pngToMask(mask.png, doc.width, doc.height)
    const op: SelectionOp =
      target === 'selection' ? useEditorStore.getState().selectionOp : 'replace'
    engine.selectFromMask(r8, op)

    if (target === 'layer-mask' && doc.activeLayerId) {
      editor.addLayerMask(doc.activeLayerId)
      engine.deselect()
    }
    samReset()
  } catch (e) {
    // Ошибка не должна тонуть в unhandled rejection — показываем её.
    console.error('[sam] commit failed', e)
    useEditorStore.getState().setToast(
      `SAM: не удалось применить маску — ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Тонированная маска для оверлея (полупрозрачная заливка + без фона). */
async function tintMask(png: Uint8Array): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(new Blob([png as BlobPart]))
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i]!
    img.data[i] = 46
    img.data[i + 1] = 154
    img.data[i + 2] = 232
    img.data[i + 3] = v > 128 ? 110 : 0
  }
  ctx.putImageData(img, 0, 0)
  return canvas.transferToImageBitmap()
}

function base64ToU8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
