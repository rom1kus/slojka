import {
  DEFAULT_BRUSH,
  extractKppPresetXml,
  parseAbr,
  parseKppParams,
  type BrushParams,
} from '@slojka/engine'
import { editor } from '../controller/EditorController'

export interface BrushPreset {
  id: string
  name: string
  params: BrushParams
  /** Серый PNG типса, base64 (для текстурных кистей). */
  tipPng?: string
}

const MAX_TIP = 512

/** Пресеты по умолчанию — процедурные круглые кисти. */
export const BUILTIN_PRESETS: BrushPreset[] = [
  {
    id: 'builtin-round',
    name: 'Круглая мягкая',
    params: { ...DEFAULT_BRUSH },
  },
  {
    id: 'builtin-hard',
    name: 'Круглая жёсткая',
    params: { ...DEFAULT_BRUSH, hardness: 0.98, spacing: 0.1 },
  },
]

export async function loadPresetLibrary(): Promise<BrushPreset[]> {
  const files = await window.slojka.listBrushes()
  const presets: BrushPreset[] = [...BUILTIN_PRESETS]
  for (const { json } of files) {
    try {
      const preset = JSON.parse(json) as BrushPreset
      if (preset.id && preset.params) {
        await registerPresetTip(preset)
        presets.push(preset)
      }
    } catch (e) {
      console.warn('Пропущен повреждённый пресет кисти', e)
    }
  }
  return presets
}

/** Импорт .kpp/.abr: диалог → парсинг → сохранение пресетов → регистрация. */
export async function importBrushFiles(): Promise<{ added: BrushPreset[]; skipped: number }> {
  const files = await window.slojka.pickBrushFiles()
  const added: BrushPreset[] = []
  let skipped = 0

  for (const file of files) {
    const bytes = new Uint8Array(file.data)
    try {
      if (file.name.toLowerCase().endsWith('.kpp')) {
        const preset = await importKpp(file.name, bytes)
        if (preset) added.push(preset)
        else skipped++
      } else if (file.name.toLowerCase().endsWith('.abr')) {
        const res = parseAbr(bytes)
        skipped += res.skipped
        for (let i = 0; i < res.tips.length; i++) {
          const tip = res.tips[i]!
          const preset = await presetFromCoverage(
            tip.name ?? `${file.name.replace(/\.abr$/i, '')} ${i + 1}`,
            tip.coverage,
            tip.width,
            tip.height,
            { spacing: tip.spacing ?? undefined },
          )
          added.push(preset)
        }
      } else {
        skipped++
      }
    } catch (e) {
      console.warn(`Не удалось импортировать ${file.name}`, e)
      skipped++
    }
  }

  for (const preset of added) {
    await window.slojka.saveBrush(`${preset.id}.json`, JSON.stringify(preset))
  }
  return { added, skipped }
}

async function importKpp(fileName: string, bytes: Uint8Array): Promise<BrushPreset | null> {
  const xml = extractKppPresetXml(bytes)
  const params = xml ? parseKppParams(xml) : null
  // Типс — сама картинка PNG.
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
  const { coverage, w, h } = coverageFromBitmap(bmp)
  return presetFromCoverage(
    params?.name ?? fileName.replace(/\.kpp$/i, ''),
    coverage,
    w,
    h,
    {
      size: params?.diameter ?? undefined,
      spacing: params?.spacing ?? undefined,
      opacity: params?.opacity ?? undefined,
      flow: params?.flow ?? undefined,
    },
  )
}

async function presetFromCoverage(
  name: string,
  coverage: Uint8Array,
  w: number,
  h: number,
  overrides: Partial<BrushParams>,
): Promise<BrushPreset> {
  const id = `imp-${crypto.randomUUID()}`
  const scaled = await scaleCoverage(coverage, w, h)
  editor.registerBrushTip(id, scaled.coverage, scaled.w, scaled.h)
  return {
    id,
    name,
    params: {
      ...DEFAULT_BRUSH,
      size: Math.min(500, Math.max(4, overrides.size ?? Math.max(w, h))),
      ...(overrides.spacing != null && overrides.spacing > 0 ? { spacing: overrides.spacing } : {}),
      ...(overrides.opacity != null ? { opacity: clamp01(overrides.opacity) } : {}),
      ...(overrides.flow != null ? { flow: clamp01(overrides.flow) } : {}),
      tipId: id,
    },
    tipPng: await coverageToPngBase64(scaled.coverage, scaled.w, scaled.h),
  }
}

async function registerPresetTip(preset: BrushPreset): Promise<void> {
  if (!preset.tipPng || !preset.params.tipId) return
  const bin = Uint8Array.from(atob(preset.tipPng), (c) => c.charCodeAt(0))
  const bmp = await createImageBitmap(new Blob([bin as BlobPart]))
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height)
  const coverage = new Uint8Array(bmp.width * bmp.height)
  for (let i = 0; i < coverage.length; i++) coverage[i] = img.data[i * 4]!
  editor.registerBrushTip(preset.params.tipId, coverage, bmp.width, bmp.height)
}

/** Coverage из картинки: альфа, если она информативна, иначе 255 − яркость. */
function coverageFromBitmap(bmp: ImageBitmap): { coverage: Uint8Array; w: number; h: number } {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height)
  const n = bmp.width * bmp.height
  let alphaVaries = false
  for (let i = 0; i < n; i++) {
    if (img.data[i * 4 + 3]! < 250) {
      alphaVaries = true
      break
    }
  }
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (alphaVaries) {
      out[i] = img.data[i * 4 + 3]!
    } else {
      const lum =
        0.2126 * img.data[i * 4]! + 0.7152 * img.data[i * 4 + 1]! + 0.0722 * img.data[i * 4 + 2]!
      out[i] = 255 - Math.round(lum)
    }
  }
  return { coverage: out, w: bmp.width, h: bmp.height }
}

async function scaleCoverage(
  coverage: Uint8Array,
  w: number,
  h: number,
): Promise<{ coverage: Uint8Array; w: number; h: number }> {
  if (Math.max(w, h) <= MAX_TIP) return { coverage, w, h }
  const k = MAX_TIP / Math.max(w, h)
  const nw = Math.max(1, Math.round(w * k))
  const nh = Math.max(1, Math.round(h * k))
  const src = new OffscreenCanvas(w, h)
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = coverage[i]!
    rgba[i * 4 + 3] = 255
  }
  src.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
  const dst = new OffscreenCanvas(nw, nh)
  const dctx = dst.getContext('2d')!
  dctx.drawImage(src, 0, 0, nw, nh)
  const img = dctx.getImageData(0, 0, nw, nh)
  const out = new Uint8Array(nw * nh)
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4]!
  return { coverage: out, w: nw, h: nh }
}

async function coverageToPngBase64(coverage: Uint8Array, w: number, h: number): Promise<string> {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = coverage[i]!
    rgba[i * 4 + 3] = 255
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s)
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(1, v))
}
