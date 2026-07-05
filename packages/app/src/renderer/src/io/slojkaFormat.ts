import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { BRAND, type DocumentJson } from '@slojka/shared'
import type { Engine } from '@slojka/engine'
import {
  maskToPng,
  pixelsToPng,
  pngToImageBitmap,
  pngToMask,
  bitmapToPremult,
  unpremultiply,
} from './pixels'

/**
 * Формат .slojka: zip в духе OpenRaster.
 *   mimetype            — image/x-slojka (без сжатия, первым)
 *   manifest.json       — DocumentJson как есть
 *   data/layer-<id>.png — пиксели растровых/текстовых слоёв
 *   data/mask-<id>.png  — маски (серый PNG)
 *   thumbnail.png       — превью ≤256px
 */
export async function saveSlojka(engine: Engine): Promise<Uint8Array> {
  const json = engine.getDocumentJson()
  if (!json) throw new Error('Нет документа')

  const files: Zippable = {
    mimetype: [strToU8(BRAND.mimetype), { level: 0 }],
    'manifest.json': strToU8(JSON.stringify(json, null, 1)),
  }

  for (const layer of json.layers) {
    const pixels = engine.readLayerPixels(layer.id)
    if (pixels) {
      files[`data/layer-${layer.id}.png`] = await pixelsToPng(pixels, json.width, json.height)
    }
    if (layer.hasMask) {
      const mask = engine.readMaskPixels(layer.id)
      if (mask) files[`data/mask-${layer.id}.png`] = await maskToPng(mask, json.width, json.height)
    }
    // Оригинал smart-слоя — полное разрешение, без потерь.
    if (layer.kind === 'raster' && layer.smart) {
      const src = engine.readSourcePixels(layer.id)
      if (src) files[`data/source-${layer.id}.png`] = await pixelsToPng(src.pixels, src.w, src.h)
    }
  }

  files['thumbnail.png'] = await makeThumbnail(engine)
  return zipSync(files, { level: 6 })
}

export async function loadSlojka(
  data: Uint8Array,
  engine: Engine,
): Promise<{ json: DocumentJson }> {
  const entries = unzipSync(data)
  const manifestRaw = entries['manifest.json']
  if (!manifestRaw) throw new Error('manifest.json не найден — файл повреждён?')
  const json = JSON.parse(strFromU8(manifestRaw)) as DocumentJson
  if (json.schema !== 1) throw new Error(`Неизвестная версия файла: ${json.schema}`)

  const layerData = new Map<string, { pixels?: Uint8Array; mask?: Uint8Array; source?: Uint8Array }>()
  for (const layer of json.layers) {
    const entry: { pixels?: Uint8Array; mask?: Uint8Array; source?: Uint8Array } = {}
    const png = entries[`data/layer-${layer.id}.png`]
    if (png) {
      const bmp = await pngToImageBitmap(png)
      entry.pixels = bitmapToPremult(bmp, json.width, json.height)
    }
    const maskPng = entries[`data/mask-${layer.id}.png`]
    if (maskPng) entry.mask = await pngToMask(maskPng, json.width, json.height)
    const srcPng = entries[`data/source-${layer.id}.png`]
    if (srcPng && layer.kind === 'raster' && layer.smart) {
      const bmp = await pngToImageBitmap(srcPng)
      entry.source = bitmapToPremult(bmp, layer.smart.srcW, layer.smart.srcH)
    }
    layerData.set(layer.id, entry)
  }

  engine.loadDocument(json, layerData)
  return { json }
}

async function makeThumbnail(engine: Engine): Promise<Uint8Array> {
  const { pixels, width, height } = engine.readComposite()
  const full = new OffscreenCanvas(width, height)
  full.getContext('2d')!.putImageData(new ImageData(unpremultiply(pixels), width, height), 0, 0)
  const k = Math.min(1, 256 / Math.max(width, height))
  const tw = Math.max(1, Math.round(width * k))
  const th = Math.max(1, Math.round(height * k))
  const thumb = new OffscreenCanvas(tw, th)
  thumb.getContext('2d')!.drawImage(full, 0, 0, tw, th)
  const blob = await thumb.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}
