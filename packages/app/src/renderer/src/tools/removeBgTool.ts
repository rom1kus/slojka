/**
 * «Удалить фон» (ПКМ по слою): нейросеть ISNet локально, без сети.
 * Тяжёлая работа — в module-worker'е (см. removeBg.worker.ts); сюда
 * приходит готовая premultiplied-картинка с вырезанным фоном, запись в
 * слой идёт через движок с полноценным undo.
 */
import i18next from 'i18next'
import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'
import type { RemoveBgJob, RemoveBgReply } from './removeBg.worker'

let worker: Worker | null = null
let nextJobId = 1

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./removeBg.worker.ts', import.meta.url), { type: 'module' })
  }
  return worker
}

function runJob(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const w = getWorker()
    const id = nextJobId++
    let modelToastShown = false

    const cleanup = (): void => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
    }
    const onMessage = (e: MessageEvent<RemoveBgReply>): void => {
      const msg = e.data
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        // Первый запуск: модель читается с диска (~90 МБ) — предупреждаем.
        if (!modelToastShown && msg.key.startsWith('fetch:')) {
          modelToastShown = true
          useEditorStore.getState().setToast(i18next.t('removeBg.loadingModel'))
        }
        return
      }
      cleanup()
      if (msg.type === 'done') resolve(msg.pixels)
      else reject(new Error(msg.message))
    }
    const onError = (e: ErrorEvent): void => {
      cleanup()
      // Worker сломался (например, не собрался бандл) — пересоздадим в
      // следующий раз с нуля.
      worker?.terminate()
      worker = null
      reject(new Error(e.message || 'worker error'))
    }

    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    const job: RemoveBgJob = { id, pixels, width, height }
    w.postMessage(job, [pixels.buffer])
  })
}

/** Запуск удаления фона на слое. Повторный вызов при занятом worker'е игнорируется. */
export async function removeLayerBackground(layerId: string): Promise<void> {
  const store = useEditorStore.getState()
  if (store.bgRemovalLayerId) return
  const doc = store.docJson
  const layer = doc?.layers.find((l) => l.id === layerId)
  if (!doc || !layer || layer.kind !== 'raster') return

  const engine = editor.engineForIo
  const smart = !!layer.smart
  let pixels: Uint8Array | null
  let w: number
  let h: number
  if (smart) {
    // Smart-слой: фон удаляется у оригинала — трансформация остаётся
    // без потерь, содержимое за краем холста не пропадает.
    const src = engine.readSourcePixels(layerId)
    if (!src) return
    pixels = src.pixels
    w = src.w
    h = src.h
  } else {
    pixels = engine.readLayerPixels(layerId)
    w = doc.width
    h = doc.height
  }
  if (!pixels) return

  store.setBgRemovalLayerId(layerId)
  store.setToast(i18next.t('removeBg.working', { name: layer.name }))
  try {
    const out = await runJob(pixels, w, h)
    // За время инференса слой могли удалить, растеризовать или сменить
    // документ — методы движка проверяют это сами и отвечают false.
    const ok = smart
      ? engine.replaceSourcePixels(layerId, out)
      : engine.replaceLayerPixels(layerId, out)
    useEditorStore
      .getState()
      .setToast(
        ok
          ? i18next.t('removeBg.done', { name: layer.name })
          : i18next.t('removeBg.layerGone'),
      )
  } catch (e) {
    console.error('[removeBg]', e)
    const detail = e instanceof Error ? e.message : String(e)
    useEditorStore.getState().setToast(`${i18next.t('removeBg.failed')}: ${detail}`)
  } finally {
    useEditorStore.getState().setBgRemovalLayerId(null)
  }
}
