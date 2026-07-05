/**
 * Разбор Photoshop .abr: версии 1/2 полностью, версия 6/7 — секция 'samp'
 * (сэмпловые типсы). Вычисляемые кисти и динамики (секция 'desc') не
 * поддерживаются — такие кисти попадают в skipped.
 */

export interface AbrTip {
  name: string | null
  width: number
  height: number
  /** R8 coverage: 255 = полная краска. */
  coverage: Uint8Array
  /** Доля диаметра (Photoshop хранит проценты). */
  spacing: number | null
}

export interface AbrResult {
  tips: AbrTip[]
  skipped: number
}

export function parseAbr(data: Uint8Array): AbrResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const version = view.getInt16(0)
  if (version === 1 || version === 2) return parseV12(data, view, version)
  if (version === 6 || version === 7 || version === 10) return parseV6(data, view)
  throw new Error(`Неподдерживаемая версия .abr: ${version}`)
}

function parseV12(data: Uint8Array, view: DataView, version: number): AbrResult {
  const count = view.getInt16(2)
  const tips: AbrTip[] = []
  let skipped = 0
  let pos = 4

  for (let i = 0; i < count && pos + 6 <= data.length; i++) {
    const type = view.getInt16(pos)
    const size = view.getInt32(pos + 2)
    const next = pos + 6 + size
    pos += 6

    if (type !== 2) {
      // 1 = computed brush — пропускаем.
      skipped++
      pos = next
      continue
    }
    try {
      pos += 4 // misc
      const spacing = view.getInt16(pos)
      pos += 2
      let name: string | null = null
      if (version === 2) {
        const len = view.getInt32(pos)
        pos += 4
        let s = ''
        for (let c = 0; c < len; c++) s += String.fromCharCode(view.getUint16(pos + c * 2))
        name = s.replace(/\0+$/, '') || null
        pos += len * 2
      }
      pos += 1 // antialiasing
      pos += 8 // bounds (short × 4)
      const top = view.getInt32(pos)
      const left = view.getInt32(pos + 4)
      const bottom = view.getInt32(pos + 8)
      const right = view.getInt32(pos + 12)
      pos += 16
      const depth = view.getInt16(pos)
      pos += 2
      const compression = data[pos]!
      pos += 1

      const w = right - left
      const h = bottom - top
      if (depth !== 8 || w <= 0 || h <= 0 || w > 5000 || h > 5000) throw new Error('bad dims')

      const coverage = compression
        ? rleDecode(data, view, pos, w, h)
        : data.slice(pos, pos + w * h)
      if (coverage.length < w * h) throw new Error('short data')
      tips.push({ name, width: w, height: h, coverage, spacing: spacing / 100 })
    } catch {
      skipped++
    }
    pos = next
  }
  return { tips, skipped }
}

function parseV6(data: Uint8Array, view: DataView): AbrResult {
  const subversion = view.getInt16(2)
  const tips: AbrTip[] = []
  let skipped = 0
  let pos = 4

  // Секции: '8BIM' + key(4) + длина(4, чётно выровнена) + данные.
  while (pos + 12 <= data.length) {
    const sig = str4(data, pos)
    const key = str4(data, pos + 4)
    const len = view.getUint32(pos + 8)
    const body = pos + 12
    if (sig !== '8BIM') break

    if (key === 'samp') {
      let p = body
      const end = body + len
      while (p + 4 < end) {
        const brushLen = view.getUint32(p)
        const brushEnd = p + 4 + brushLen + ((4 - (brushLen % 4)) % 4)
        try {
          // Заголовок сэмпла: id-строка + служебные поля; смещения как в GIMP.
          let q = p + 4
          q += subversion === 1 ? 47 : 301
          const top = view.getInt32(q)
          const left = view.getInt32(q + 4)
          const bottom = view.getInt32(q + 8)
          const right = view.getInt32(q + 12)
          const depth = view.getInt16(q + 16)
          const compression = data[q + 18]!
          q += 19
          const w = right - left
          const h = bottom - top
          if (depth !== 8 || w <= 0 || h <= 0 || w > 5000 || h > 5000) throw new Error('bad dims')
          const coverage = compression ? rleDecode(data, view, q, w, h) : data.slice(q, q + w * h)
          if (coverage.length < w * h) throw new Error('short data')
          tips.push({ name: null, width: w, height: h, coverage, spacing: null })
        } catch {
          skipped++
        }
        p = brushEnd
      }
    }
    pos = body + len + (len % 2) // чётное выравнивание секции
  }
  if (tips.length === 0 && skipped === 0) throw new Error("Секция 'samp' не найдена")
  return { tips, skipped }
}

/** PackBits: таблица длин строк (int16 × h), затем сжатые строки. */
function rleDecode(
  data: Uint8Array,
  view: DataView,
  pos: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h)
  let p = pos + h * 2 // пропустить таблицу длин
  let o = 0

  while (o < out.length && p < data.length) {
    const n = view.getInt8(p)
    p += 1
    if (n >= 0) {
      const cnt = n + 1
      out.set(data.subarray(p, p + cnt), o)
      p += cnt
      o += cnt
    } else if (n !== -128) {
      const cnt = 1 - n
      out.fill(data[p]!, o, o + cnt)
      p += 1
      o += cnt
    }
  }
  return out
}

function str4(data: Uint8Array, pos: number): string {
  return String.fromCharCode(data[pos]!, data[pos + 1]!, data[pos + 2]!, data[pos + 3]!)
}
