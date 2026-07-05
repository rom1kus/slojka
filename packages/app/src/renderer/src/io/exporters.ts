import type { Engine } from '@slojka/engine'
import { unpremultiply } from './pixels'

export type ExportFormat = 'png' | 'jpg' | 'webp'

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

/** Экспорт композита. JPEG не умеет альфу — подкладываем белый. */
export async function exportComposite(
  engine: Engine,
  format: ExportFormat,
  quality = 0.92,
): Promise<Uint8Array> {
  const { pixels, width, height } = engine.readComposite()
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  if (format === 'jpg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    const tmp = new OffscreenCanvas(width, height)
    tmp.getContext('2d')!.putImageData(new ImageData(unpremultiply(pixels), width, height), 0, 0)
    ctx.drawImage(tmp, 0, 0)
  } else {
    ctx.putImageData(new ImageData(unpremultiply(pixels), width, height), 0, 0)
  }
  const blob = await canvas.convertToBlob({ type: MIME[format], quality })
  return new Uint8Array(await blob.arrayBuffer())
}

export function formatFromPath(path: string): ExportFormat {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg'
  if (ext === 'webp') return 'webp'
  return 'png'
}
