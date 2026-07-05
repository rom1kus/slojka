import { unzlibSync } from 'fflate'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Извлекает XML пресета из .kpp (Krita preset = PNG с текстовым чанком
 * 'preset' в tEXt/zTXt/iTXt). Возвращает null, если чанк не найден.
 * Чистый бинарный разбор — сам PNG декодируется отдельно (createImageBitmap).
 */
export function extractKppPresetXml(data: Uint8Array): string | null {
  if (data.length < 8 || PNG_SIG.some((b, i) => data[i] !== b)) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let pos = 8

  while (pos + 8 <= data.length) {
    const len = view.getUint32(pos)
    const type = String.fromCharCode(data[pos + 4]!, data[pos + 5]!, data[pos + 6]!, data[pos + 7]!)
    const body = data.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len // length + type + data + crc

    if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') {
      if (type === 'IEND') break
      continue
    }
    const nul = body.indexOf(0)
    if (nul < 0) continue
    const keyword = latin1(body.subarray(0, nul))
    if (keyword !== 'preset') continue

    try {
      if (type === 'tEXt') return latin1(body.subarray(nul + 1))
      if (type === 'zTXt') {
        // keyword \0 method(1) deflate-данные
        return utf8(unzlibSync(body.subarray(nul + 2)))
      }
      // iTXt: keyword \0 compressed(1) method(1) lang \0 translated \0 text
      const compressed = body[nul + 1] === 1
      let p = nul + 3
      p = body.indexOf(0, p) + 1 // lang
      p = body.indexOf(0, p) + 1 // translated keyword
      const text = body.subarray(p)
      return compressed ? utf8(unzlibSync(text)) : utf8(text)
    } catch {
      return null
    }
  }
  return null
}

/** Разбор интересующих параметров из XML пресета Krita (без DOMParser). */
export interface KppParams {
  name: string | null
  spacing: number | null
  diameter: number | null
  opacity: number | null
  flow: number | null
}

export function parseKppParams(xml: string): KppParams {
  const name = attr(xml, /<Preset[^>]*\bname="([^"]*)"/) ?? null
  // brush_definition хранит вложенный (экранированный) XML <Brush ... spacing=".." diameter="..">
  const brushDef = xml.match(/<param\s+name="brush_definition"[^>]*>([\s\S]*?)<\/param>/)?.[1]
  const unescaped = brushDef ? unescapeXml(brushDef) : ''
  return {
    name,
    spacing: num(attr(unescaped, /\bspacing="([^"]+)"/)),
    diameter: num(attr(unescaped, /\bdiameter="([^"]+)"/) ?? attr(unescaped, /\bwidth="([^"]+)"/)),
    opacity: num(paramValue(xml, 'OpacityValue')),
    flow: num(paramValue(xml, 'FlowValue')),
  }
}

function paramValue(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<param\\s+name="${name}"[^>]*>([\\s\\S]*?)</param>`))
  return m?.[1]?.trim() ?? null
}

function attr(s: string, re: RegExp): string | null {
  return s.match(re)?.[1] ?? null
}

function num(s: string | null): number | null {
  if (s === null) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function latin1(b: Uint8Array): string {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return s
}

function utf8(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}
