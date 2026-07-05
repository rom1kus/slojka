import { describe, expect, it } from 'vitest'
import { zlibSync } from 'fflate'
import { extractKppPresetXml, parseKppParams } from '../src/brush/kpp'
import { parseAbr } from '../src/brush/abr'

// ── Синтетический PNG с чанками ──

function crcStub(): Uint8Array {
  return new Uint8Array(4) // парсер CRC не проверяет
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  new DataView(out.buffer).setUint32(0, body.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(body, 8)
  out.set(crcStub(), 8 + body.length)
  return out
}

function makePng(chunks: Uint8Array[]): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const iend = chunk('IEND', new Uint8Array(0))
  const total = [sig, ...chunks, iend]
  const out = new Uint8Array(total.reduce((s, c) => s + c.length, 0))
  let o = 0
  for (const c of total) {
    out.set(c, o)
    o += c.length
  }
  return out
}

const PRESET_XML =
  '<Preset name="Тестовая кисть" paintopid="paintbrush">' +
  '<param name="OpacityValue">0.8</param>' +
  '<param name="FlowValue">0.5</param>' +
  '<param name="brush_definition">&lt;Brush type="auto" spacing="0.15" diameter="42"/&gt;</param>' +
  '</Preset>'

function textChunk(keyword: string, text: string): Uint8Array {
  const k = [...keyword].map((c) => c.charCodeAt(0))
  const t = [...text].map((c) => c.charCodeAt(0) & 0xff)
  return chunk('tEXt', new Uint8Array([...k, 0, ...t]))
}

describe('kpp', () => {
  it('извлекает preset из tEXt', () => {
    const ascii = PRESET_XML.replace('Тестовая кисть', 'Test brush')
    const png = makePng([textChunk('preset', ascii)])
    expect(extractKppPresetXml(png)).toBe(ascii)
  })

  it('извлекает preset из zTXt (deflate)', () => {
    const compressed = zlibSync(new TextEncoder().encode(PRESET_XML))
    const body = new Uint8Array([...'preset'].map((c) => c.charCodeAt(0)).concat(0, 0), )
    const full = new Uint8Array(body.length + compressed.length)
    full.set(body)
    full.set(compressed, body.length)
    const png = makePng([chunk('zTXt', full)])
    expect(extractKppPresetXml(png)).toBe(PRESET_XML)
  })

  it('возвращает null без чанка preset', () => {
    expect(extractKppPresetXml(makePng([textChunk('other', 'x')]))).toBeNull()
  })

  it('парсит параметры Krita', () => {
    const p = parseKppParams(PRESET_XML)
    expect(p.name).toBe('Тестовая кисть')
    expect(p.spacing).toBeCloseTo(0.15)
    expect(p.diameter).toBe(42)
    expect(p.opacity).toBeCloseTo(0.8)
    expect(p.flow).toBeCloseTo(0.5)
  })
})

// ── Синтетический .abr v1 ──

function makeAbrV1(tipW: number, tipH: number, spacingPct: number): Uint8Array {
  const pixels = new Uint8Array(tipW * tipH).fill(200)
  const brushBody = new Uint8Array(4 + 2 + 1 + 8 + 16 + 2 + 1 + pixels.length)
  const v = new DataView(brushBody.buffer)
  let p = 0
  v.setInt32(p, 0) // misc
  p += 4
  v.setInt16(p, spacingPct)
  p += 2
  p += 1 // antialias
  p += 8 // короткие bounds
  v.setInt32(p, 0) // top
  v.setInt32(p + 4, 0) // left
  v.setInt32(p + 8, tipH) // bottom
  v.setInt32(p + 12, tipW) // right
  p += 16
  v.setInt16(p, 8) // depth
  p += 2
  brushBody[p] = 0 // без сжатия
  p += 1
  brushBody.set(pixels, p)

  const out = new Uint8Array(4 + 6 + brushBody.length)
  const ov = new DataView(out.buffer)
  ov.setInt16(0, 1) // version 1
  ov.setInt16(2, 1) // count 1
  ov.setInt16(4, 2) // type: sampled
  ov.setInt32(6, brushBody.length)
  out.set(brushBody, 10)
  return out
}

describe('abr', () => {
  it('парсит сэмпловую кисть v1', () => {
    const abr = makeAbrV1(16, 8, 25)
    const res = parseAbr(abr)
    expect(res.skipped).toBe(0)
    expect(res.tips).toHaveLength(1)
    const tip = res.tips[0]!
    expect(tip.width).toBe(16)
    expect(tip.height).toBe(8)
    expect(tip.spacing).toBeCloseTo(0.25)
    expect(tip.coverage[0]).toBe(200)
    expect(tip.coverage.length).toBe(16 * 8)
  })

  it('падает на мусоре с понятной ошибкой', () => {
    const junk = new Uint8Array([0, 99, 1, 2, 3, 4])
    expect(() => parseAbr(junk)).toThrow(/версия/)
  })
})
