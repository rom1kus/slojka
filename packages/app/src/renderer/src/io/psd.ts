import { readPsd, type Layer as PsdLayer } from 'ag-psd'
import { newLayerId, type BlendMode, type DocumentJson, type LayerJson } from '@slojka/shared'
import type { Engine } from '@slojka/engine'
import { bitmapToPremult } from './pixels'

const PSD_BLEND: Record<string, BlendMode> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  'soft light': 'soft-light',
  darken: 'darken',
  lighten: 'lighten',
  'linear dodge': 'add',
}

export interface PsdImportReport {
  imported: number
  flattenedGroups: number
  degraded: string[]
}

/**
 * Импорт PSD (best-effort, ag-psd): растровые слои, группы (уплощаются
 * с префиксом имени), маски, blend-режимы из поддержанного набора.
 * Текстовые слои приходят растеризованными (PSD хранит растр).
 */
export async function importPsd(
  data: ArrayBuffer,
  engine: Engine,
): Promise<{ json: DocumentJson; report: PsdImportReport }> {
  const psd = readPsd(data)
  const width = psd.width
  const height = psd.height
  if (!width || !height) throw new Error('Некорректный PSD')

  const report: PsdImportReport = { imported: 0, flattenedGroups: 0, degraded: [] }
  const layers: LayerJson[] = []
  const layerData = new Map<string, { pixels?: Uint8Array; mask?: Uint8Array }>()

  const walk = (items: PsdLayer[], prefix: string): void => {
    // ag-psd отдаёт children снизу вверх — как у нас.
    for (const item of items) {
      if (item.children) {
        report.flattenedGroups++
        walk(item.children, `${prefix}${item.name ?? 'Группа'} / `)
        continue
      }
      const canvas = item.canvas as HTMLCanvasElement | undefined
      if (!canvas) {
        report.degraded.push(`${prefix}${item.name ?? '?'}: нет растровых данных`)
        continue
      }
      const full = new OffscreenCanvas(width, height)
      full.getContext('2d')!.drawImage(canvas, item.left ?? 0, item.top ?? 0)

      const id = newLayerId()
      const blendMode = PSD_BLEND[item.blendMode ?? 'normal']
      if (!blendMode && item.blendMode) {
        report.degraded.push(`${prefix}${item.name ?? '?'}: режим «${item.blendMode}» → normal`)
      }

      let mask: Uint8Array | undefined
      const maskCanvas = item.mask?.canvas as HTMLCanvasElement | undefined
      if (maskCanvas) {
        const m = new OffscreenCanvas(width, height)
        const mctx = m.getContext('2d')!
        // Вне маски PSD подразумевает белое (видимо), если не задано defaultColor=0.
        mctx.fillStyle = (item.mask?.defaultColor ?? 255) === 0 ? '#000' : '#fff'
        mctx.fillRect(0, 0, width, height)
        mctx.drawImage(maskCanvas, item.mask?.left ?? 0, item.mask?.top ?? 0)
        const img = mctx.getImageData(0, 0, width, height)
        mask = new Uint8Array(width * height)
        for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4]!
      }

      layers.push({
        kind: 'raster',
        id,
        name: `${prefix}${item.name ?? 'Слой'}`,
        visible: !item.hidden,
        opacity: item.opacity ?? 1,
        blendMode: blendMode ?? 'normal',
        clipped: item.clipping ?? false,
        hasMask: mask !== undefined,
      })
      layerData.set(id, {
        pixels: bitmapToPremult(full.transferToImageBitmap(), width, height),
        ...(mask ? { mask } : {}),
      })
      report.imported++
    }
  }

  walk(psd.children ?? [], '')
  if (layers.length === 0) throw new Error('В PSD не найдено ни одного слоя с данными')

  const json: DocumentJson = {
    schema: 1,
    width,
    height,
    layers,
    activeLayerId: layers.at(-1)?.id ?? null,
  }
  engine.loadDocument(json, layerData)
  return { json, report }
}
