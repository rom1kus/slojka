/**
 * Worker удаления фона: ONNX-инференс (ISNet через @imgly/background-removal)
 * идёт вне UI-потока. Модель и wasm загружаются с slojka-res://imgly/
 * (локальные файлы, без сети) и после первого запуска остаются в памяти
 * worker'а — повторные вызовы заметно быстрее.
 */
import { segmentForeground } from '@imgly/background-removal'

export interface RemoveBgJob {
  id: number
  /** premultiplied RGBA (строка 0 — верх). */
  pixels: Uint8Array
  width: number
  height: number
}

export type RemoveBgReply =
  | { id: number; type: 'progress'; key: string; current: number; total: number }
  | { id: number; type: 'done'; pixels: Uint8Array }
  | { id: number; type: 'error'; message: string }

const post = (msg: RemoveBgReply, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(msg, transfer)
}

self.onmessage = async (e: MessageEvent<RemoveBgJob>) => {
  const { id, pixels, width, height } = e.data
  try {
    // 1. premultiplied → straight RGBA: PNG-вход для модели.
    const straight = new Uint8ClampedArray(pixels.length)
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3]!
      if (a === 0) continue
      const k = 255 / a
      straight[i] = pixels[i]! * k
      straight[i + 1] = pixels[i + 1]! * k
      straight[i + 2] = pixels[i + 2]! * k
      straight[i + 3] = a
    }
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(straight, width, height), 0, 0)
    const png = await canvas.convertToBlob({ type: 'image/png' })

    // 2. Инференс: альфа-матте объекта в исходном разрешении.
    const matteBlob = await segmentForeground(png, {
      publicPath: 'slojka-res://imgly/',
      model: 'medium',
      // Инференс уже в worker'е — внутренний прокси ort не нужен.
      proxyToWorker: false,
      output: { format: 'image/x-alpha8' },
      progress: (key, current, total) => post({ id, type: 'progress', key, current, total }),
    })
    const matte = new Uint8Array(await matteBlob.arrayBuffer())
    if (matte.length !== width * height) {
      throw new Error(`матте ${matte.length} байт, ожидалось ${width * height}`)
    }

    // 3. Фон срезается матте: premultiplied RGBA умножается на неё целиком
    //    (цвета слоя не перекодируются — без потерь).
    const out = new Uint8Array(pixels.length)
    for (let p = 0, i = 0; p < matte.length; p++, i += 4) {
      const m = matte[p]!
      if (m === 0) continue
      if (m === 255) {
        out[i] = pixels[i]!
        out[i + 1] = pixels[i + 1]!
        out[i + 2] = pixels[i + 2]!
        out[i + 3] = pixels[i + 3]!
      } else {
        out[i] = (pixels[i]! * m + 127) / 255
        out[i + 1] = (pixels[i + 1]! * m + 127) / 255
        out[i + 2] = (pixels[i + 2]! * m + 127) / 255
        out[i + 3] = (pixels[i + 3]! * m + 127) / 255
      }
    }
    post({ id, type: 'done', pixels: out }, [out.buffer])
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
