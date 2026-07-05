import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { newLayerId, type BlendMode, type DocumentJson, type LayerJson } from '@slojka/shared'
import type { Engine } from '@slojka/engine'
import { bitmapToPremult, pixelsToPng, pngToImageBitmap } from './pixels'
import { exportComposite } from './exporters'

const TO_ORA: Record<BlendMode, string> = {
  normal: 'svg:src-over',
  multiply: 'svg:multiply',
  screen: 'svg:screen',
  overlay: 'svg:overlay',
  'soft-light': 'svg:soft-light',
  darken: 'svg:darken',
  lighten: 'svg:lighten',
  add: 'svg:plus',
}
const FROM_ORA: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(TO_ORA).map(([k, v]) => [v, k as BlendMode]),
)

/** Экспорт в OpenRaster (Krita/GIMP/MyPaint). Маски вжигаются в альфу нет — v1: маски и клип не переносятся. */
export async function exportOra(engine: Engine): Promise<Uint8Array> {
  const json = engine.getDocumentJson()
  if (!json) throw new Error('Нет документа')

  const xml: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<image version="0.0.3" w="${json.width}" h="${json.height}" xres="72" yres="72">`,
    '<stack>',
  ]
  const files: Zippable = {
    mimetype: [strToU8('image/openraster'), { level: 0 }],
  }

  // В stack.xml слои идут сверху вниз.
  const ordered = [...json.layers].reverse()
  for (let i = 0; i < ordered.length; i++) {
    const layer = ordered[i]!
    const pixels = engine.readLayerPixels(layer.id)
    if (!pixels) continue
    const src = `data/layer-${i}.png`
    files[src] = await pixelsToPng(pixels, json.width, json.height)
    xml.push(
      `<layer name="${escapeXml(layer.name)}" src="${src}" x="0" y="0" ` +
        `opacity="${layer.opacity}" visibility="${layer.visible ? 'visible' : 'hidden'}" ` +
        `composite-op="${TO_ORA[layer.blendMode]}" />`,
    )
  }
  xml.push('</stack>', '</image>')
  files['stack.xml'] = strToU8(xml.join('\n'))
  files['mergedimage.png'] = await exportComposite(engine, 'png')
  return zipSync(files, { level: 6 })
}

export async function importOra(data: Uint8Array, engine: Engine): Promise<DocumentJson> {
  const entries = unzipSync(data)
  const stackXml = entries['stack.xml']
  if (!stackXml) throw new Error('stack.xml не найден')
  const doc = new DOMParser().parseFromString(strFromU8(stackXml), 'text/xml')
  const image = doc.querySelector('image')
  const width = Number(image?.getAttribute('w')) || 0
  const height = Number(image?.getAttribute('h')) || 0
  if (!width || !height) throw new Error('Некорректный stack.xml')

  const layerEls = [...doc.querySelectorAll('layer')]
  const layers: LayerJson[] = []
  const layerData = new Map<string, { pixels?: Uint8Array; mask?: Uint8Array }>()

  // В stack.xml — сверху вниз; у нас [0] — низ.
  for (const el of layerEls.reverse()) {
    const src = el.getAttribute('src') ?? ''
    const png = entries[src]
    if (!png) continue
    const bmp = await pngToImageBitmap(png)
    const x = Number(el.getAttribute('x')) || 0
    const y = Number(el.getAttribute('y')) || 0
    // Слои ORA могут быть меньше документа и с оффсетом — кладём на холст.
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d')!.drawImage(bmp, x, y)
    const id = newLayerId()
    layers.push({
      kind: 'raster',
      id,
      name: el.getAttribute('name') ?? 'Слой',
      visible: el.getAttribute('visibility') !== 'hidden',
      opacity: clamp01(Number(el.getAttribute('opacity') ?? 1)),
      blendMode: FROM_ORA[el.getAttribute('composite-op') ?? ''] ?? 'normal',
      clipped: false,
      hasMask: false,
    })
    layerData.set(id, {
      pixels: bitmapToPremult(canvas.transferToImageBitmap(), width, height),
    })
  }

  const json: DocumentJson = {
    schema: 1,
    width,
    height,
    layers,
    activeLayerId: layers.at(-1)?.id ?? null,
  }
  engine.loadDocument(json, layerData)
  return json
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
}
