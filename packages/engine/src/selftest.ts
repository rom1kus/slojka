import { Engine } from './engine'
import { DEFAULT_BRUSH } from './brush/types'

export interface SelfTestResult {
  pass: boolean
  failures: string[]
}

function px(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const i = (y * width + x) * 4
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!]
}

function near(actual: readonly number[], expected: readonly number[], tol = 3): boolean {
  return actual.every((v, i) => Math.abs(v - (expected[i] ?? 0)) <= tol)
}

/**
 * Самотест движка на живом GL: композиция, blend-режимы, кисть, ластик, undo.
 * Запускается в смоук-режиме приложения; результат уходит в SMOKE_RESULT.
 */
export function runEngineSelfTest(): SelfTestResult {
  const failures: string[] = []
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(8, 8)
      : (document.createElement('canvas') as HTMLCanvasElement)

  let engine: Engine
  try {
    engine = new Engine(canvas)
  } catch (e) {
    return { pass: false, failures: [`создание движка: ${String(e)}`] }
  }

  try {
    // 1. Белый фон.
    engine.newDocument(16, 16, 'white')
    let c = engine.readComposite()
    if (!near(px(c.pixels, 16, 8, 8), [255, 255, 255, 255])) {
      failures.push(`белый фон: ${px(c.pixels, 16, 8, 8).join(',')}`)
    }

    // 2. Normal: полупрозрачный красный слой поверх белого.
    engine.addLayer('L1')
    engine.fillActiveLayer([1, 0, 0, 1])
    const doc = engine.getDocumentJson()!
    engine.setLayerProps(doc.layers[1]!.id, { opacity: 0.5 })
    c = engine.readComposite()
    if (!near(px(c.pixels, 16, 8, 8), [255, 128, 128, 255])) {
      failures.push(`normal 50%: ${px(c.pixels, 16, 8, 8).join(',')}`)
    }

    // 3. Multiply: (200,100,50) × (100,200,30).
    engine.newDocument(16, 16, 'transparent')
    engine.fillActiveLayer([200 / 255, 100 / 255, 50 / 255, 1])
    engine.addLayer('M')
    engine.fillActiveLayer([100 / 255, 200 / 255, 30 / 255, 1])
    const doc3 = engine.getDocumentJson()!
    engine.setLayerProps(doc3.layers[1]!.id, { blendMode: 'multiply' })
    c = engine.readComposite()
    if (!near(px(c.pixels, 16, 8, 8), [78, 78, 6, 255])) {
      failures.push(`multiply: ${px(c.pixels, 16, 8, 8).join(',')}`)
    }

    // 4. Кисть: чёрный мазок по центру белого документа + undo/redo.
    engine.newDocument(32, 32, 'white')
    engine.beginStroke(
      'brush',
      { ...DEFAULT_BRUSH, size: 16, hardness: 1, pressureSize: false },
      [0, 0, 0, 1],
      { x: 16, y: 16, pressure: 0.5 },
    )
    engine.endStroke()
    c = engine.readComposite()
    if (!near(px(c.pixels, 32, 16, 16), [0, 0, 0, 255], 10)) {
      failures.push(`кисть: ${px(c.pixels, 32, 16, 16).join(',')}`)
    }
    engine.undo()
    c = engine.readComposite()
    if (!near(px(c.pixels, 32, 16, 16), [255, 255, 255, 255])) {
      failures.push(`undo кисти: ${px(c.pixels, 32, 16, 16).join(',')}`)
    }
    engine.redo()
    c = engine.readComposite()
    if (!near(px(c.pixels, 32, 16, 16), [0, 0, 0, 255], 10)) {
      failures.push(`redo кисти: ${px(c.pixels, 32, 16, 16).join(',')}`)
    }

    // 5а. Выделение клипит кисть: выделена левая половина.
    engine.newDocument(32, 32, 'white')
    engine.selectRect(0, 0, 16, 32, 'replace')
    engine.beginStroke(
      'brush',
      { ...DEFAULT_BRUSH, size: 20, hardness: 1, pressureSize: false },
      [0, 0, 0, 1],
      { x: 16, y: 16, pressure: 0.5 },
    )
    engine.endStroke()
    c = engine.readComposite()
    const inSel = px(c.pixels, 32, 12, 16)
    const outSel = px(c.pixels, 32, 20, 16)
    if (inSel[0]! > 40) failures.push(`клип выделением (внутри): ${inSel.join(',')}`)
    if (outSel[0]! < 240) failures.push(`клип выделением (снаружи): ${outSel.join(',')}`)
    engine.deselect()
    if (engine.hasSelection) failures.push('deselect не снял выделение')

    // 5б. Маска слоя из выделения скрывает невыделенное.
    engine.newDocument(32, 32, 'white')
    engine.addLayer('Red')
    engine.fillActiveLayer([1, 0, 0, 1])
    const redId = engine.getDocumentJson()!.activeLayerId!
    engine.selectRect(16, 0, 16, 32, 'replace')
    engine.addLayerMask(redId, true)
    engine.deselect()
    c = engine.readComposite()
    const masked = px(c.pixels, 32, 8, 16) // слева маска чёрная → виден белый фон
    const shown = px(c.pixels, 32, 24, 16) // справа маска белая → красный
    if (!near(masked, [255, 255, 255, 255], 6)) failures.push(`маска (скрыто): ${masked.join(',')}`)
    if (!near(shown, [255, 0, 0, 255], 6)) failures.push(`маска (видно): ${shown.join(',')}`)
    engine.undo() // снять deselect
    engine.undo() // снять маску
    c = engine.readComposite()
    if (!near(px(c.pixels, 32, 8, 16), [255, 0, 0, 255], 6)) {
      failures.push(`undo маски: ${px(c.pixels, 32, 8, 16).join(',')}`)
    }

    // 5в. Текстовый слой рисует непрозрачные пиксели (символ █).
    engine.newDocument(48, 48, 'white')
    engine.addTextLayer('T', {
      content: '█',
      fontFamily: 'sans-serif',
      fontStyle: 'normal',
      fontSize: 32,
      color: '#000000',
      letterSpacing: 0,
      lineHeight: 1.2,
      align: 'left',
      x: 4,
      y: 4,
    })
    c = engine.readComposite()
    let darkCount = 0
    for (let y = 4; y < 40; y++) {
      for (let x = 4; x < 30; x++) {
        if (px(c.pixels, 48, x, y)[0]! < 100) darkCount++
      }
    }
    if (darkCount < 50) failures.push(`текст: тёмных пикселей ${darkCount}`)

    // 5в². Стиль фрагмента: второй символ ██ красный, первый остаётся чёрным.
    engine.newDocument(96, 48, 'white')
    engine.addTextLayer('T2', {
      content: '██',
      fontFamily: 'sans-serif',
      fontStyle: 'normal',
      fontSize: 32,
      color: '#000000',
      letterSpacing: 0,
      lineHeight: 1.2,
      align: 'left',
      x: 4,
      y: 4,
      styleRanges: [{ start: 1, end: 2, color: '#ff0000' }],
    })
    c = engine.readComposite()
    let fragBlack = 0
    let fragRed = 0
    for (let y = 4; y < 44; y++) {
      for (let x = 4; x < 92; x++) {
        const q = px(c.pixels, 96, x, y)
        if (q[0]! < 80 && q[1]! < 80) fragBlack++
        else if (q[0]! > 180 && q[1]! < 80 && q[2]! < 80) fragRed++
      }
    }
    if (fragBlack < 50 || fragRed < 50) {
      failures.push(`цвет фрагмента текста: чёрных ${fragBlack}, красных ${fragRed}`)
    }
    // Правка контента сдвигает диапазон: символ в начале → красный сместился.
    const t2 = engine.getDocumentJson()!.activeLayerId!
    engine.setTextParams(t2, { content: 'A██' }, { history: false })
    const t2Json = engine.getDocumentJson()!.layers.find((l) => l.id === t2)!
    const rr = t2Json.kind === 'text' ? t2Json.text.styleRanges : undefined
    if (!(rr?.length === 1 && rr[0]!.start === 2 && rr[0]!.end === 3)) {
      failures.push(`сдвиг styleRanges после правки: ${JSON.stringify(rr)}`)
    }
    // Свой размер у фрагмента: увеличенный второй символ выше базового.
    engine.setTextParams(
      t2,
      { content: '██', styleRanges: [{ start: 1, end: 2, color: '#ff0000', fontSize: 44 }] },
      { history: false },
    )
    c = engine.readComposite()
    const colHeight = (x: number, isRed: boolean): number => {
      let n = 0
      for (let y = 0; y < 48; y++) {
        const q = px(c.pixels, 96, x, y)
        const hit = isRed ? q[0]! > 180 && q[1]! < 80 : q[0]! < 80 && q[1]! < 80
        if (hit) n++
      }
      return n
    }
    // Ищем самые «высокие» колонки каждого цвета по всей ширине.
    let hBlack = 0
    let hRed = 0
    for (let x = 0; x < 96; x++) {
      hBlack = Math.max(hBlack, colHeight(x, false))
      hRed = Math.max(hRed, colHeight(x, true))
    }
    if (!(hRed > hBlack + 4)) {
      failures.push(`размер фрагмента: чёрный ${hBlack}px, красный ${hRed}px`)
    }

    // 5г. Муравьи: рёбра выделения видны на present (и вертикальные тоже).
    engine.newDocument(64, 64, 'white')
    engine.selectRect(16, 16, 32, 32, 'replace')
    engine.resizeDisplay(64, 64, 1)
    engine.setView({ panX: 0, panY: 0, scale: 1 })
    engine.render()
    const disp = engine.readDisplayPixels()
    // Полосы паттерна чередуются чёрным/белым — ищем тёмные пиксели вдоль
    // всей граничной колонки/строки (белые штрихи на белом фоне не видны).
    const darkAt = (x: number, y: number): boolean =>
      disp.pixels[((disp.height - 1 - y) * disp.width + x) * 4]! < 100
    let vertEdges = 0
    let horizEdges = 0
    for (let i = 16; i < 48; i++) {
      if (darkAt(16, i) || darkAt(47, i)) vertEdges++
      if (darkAt(i, 16) || darkAt(i, 47)) horizEdges++
    }
    if (horizEdges < 5) failures.push(`муравьи: горизонтальных рёбер мало (${horizEdges})`)
    if (vertEdges < 5) failures.push(`муравьи: вертикальных рёбер мало (${vertEdges})`)
    engine.deselect()

    // 5д. Внешняя тень: непрозрачный квадрат в центре, тень вправо-вниз.
    engine.newDocument(64, 64, 'white')
    engine.addLayer('Box')
    engine.selectRect(24, 24, 16, 16, 'replace')
    engine.beginStroke(
      'brush',
      { ...DEFAULT_BRUSH, size: 40, hardness: 1, pressureSize: false },
      [1, 0, 0, 1],
      { x: 32, y: 32, pressure: 0.5 },
    )
    engine.endStroke()
    engine.deselect()
    const boxId = engine.getDocumentJson()!.activeLayerId!
    engine.setLayerStyles(boxId, {
      dropShadow: { enabled: true, color: '#000000', opacity: 1, distance: 8, angle: 45, size: 0 },
    })
    c = engine.readComposite()
    // Тень на (43,43): за пределами квадрата (24..40), внутри смещённой тени.
    const shadowPx = px(c.pixels, 64, 43, 43)
    if (shadowPx[0]! > 120) failures.push(`тень не видна: ${shadowPx.join(',')}`)
    const farPx = px(c.pixels, 64, 8, 8)
    if (!near(farPx, [255, 255, 255, 255], 6)) failures.push(`тень залила фон: ${farPx.join(',')}`)
    // «Размер» (spread, px) расширяет тень: с ним точка за краем заметно темнее.
    engine.setLayerStyles(boxId, {
      dropShadow: { enabled: true, color: '#000000', opacity: 1, distance: 0, angle: 0, size: 8 },
    })
    c = engine.readComposite()
    const noSpread = px(c.pixels, 64, 44, 32)[0]!
    engine.setLayerStyles(boxId, {
      dropShadow: {
        enabled: true,
        color: '#000000',
        opacity: 1,
        distance: 0,
        angle: 0,
        size: 8,
        spread: 8,
      },
    })
    c = engine.readComposite()
    const withSpread = px(c.pixels, 64, 44, 32)[0]!
    if (!(withSpread < noSpread - 30)) {
      failures.push(`spread не расширяет тень: без=${noSpread}, с=${withSpread}`)
    }
    engine.setLayerStyles(boxId, undefined)

    // 5е. Floating: вырезать выделенное, сдвинуть на 12px, применить.
    engine.newDocument(32, 32, 'white')
    engine.addLayer('Sq')
    engine.selectRect(4, 4, 8, 8, 'replace')
    engine.fillSelectedArea([1, 0, 0, 1])
    if (!engine.liftSelection()) failures.push('liftSelection не сработал')
    engine.setFloatingTransform({ dx: 12 })
    engine.commitFloating()
    c = engine.readComposite()
    const oldSpot = px(c.pixels, 32, 8, 8) // где был квадрат → белый фон
    const newSpot = px(c.pixels, 32, 20, 8) // куда переехал → красный
    if (!near(oldSpot, [255, 255, 255, 255], 8)) failures.push(`move: старое место ${oldSpot.join(',')}`)
    if (!near(newSpot, [255, 0, 0, 255], 8)) failures.push(`move: новое место ${newSpot.join(',')}`)
    engine.undo()
    c = engine.readComposite()
    if (!near(px(c.pixels, 32, 8, 8), [255, 0, 0, 255], 8)) {
      failures.push(`undo move: ${px(c.pixels, 32, 8, 8).join(',')}`)
    }

    // 5ж. R8-маски на ширине, НЕ кратной 4 (UNPACK_ALIGNMENT!).
    engine.newDocument(501, 253, 'white')
    engine.selectRect(100, 60, 200, 100, 'replace')
    {
      const sel = engine.readSelectionMask()
      const idx = (110 * 501 + 200) // строка 110, колонка 200 — внутри
      const out = (30 * 501 + 30) // снаружи
      if (sel.mask[idx]! < 200) failures.push(`R8 501px: внутри=${sel.mask[idx]}`)
      if (sel.mask[out]! > 50) failures.push(`R8 501px: снаружи=${sel.mask[out]}`)
      // Круговой путь: маска → selectFromMask → чтение (как в SAM).
      const copy = new Uint8Array(sel.mask)
      engine.deselect()
      engine.selectFromMask(copy, 'replace')
      const sel2 = engine.readSelectionMask()
      if (sel2.mask[idx]! < 200) failures.push(`selectFromMask 501px: внутри=${sel2.mask[idx]}`)
      let nonzero = 0
      for (let i = 0; i < sel2.mask.length; i++) if (sel2.mask[i]! > 128) nonzero++
      if (Math.abs(nonzero - 200 * 100) > 2000) {
        failures.push(`selectFromMask 501px: площадь=${nonzero}, ожидалось ~20000`)
      }
    }

    // 5з. Ctrl+A: муравьи видны по периметру документа.
    engine.newDocument(64, 64, 'white')
    engine.selectAll()
    engine.resizeDisplay(64, 64, 1)
    engine.setView({ panX: 0, panY: 0, scale: 1 })
    engine.render()
    {
      const disp = engine.readDisplayPixels()
      const darkAt = (x: number, y: number): boolean =>
        disp.pixels[((disp.height - 1 - y) * disp.width + x) * 4]! < 100
      let perim = 0
      for (let i = 2; i < 62; i++) {
        if (darkAt(i, 0) || darkAt(i, 1)) perim++
        if (darkAt(0, i) || darkAt(1, i)) perim++
      }
      if (perim < 10) failures.push(`Ctrl+A муравьи по периметру: ${perim}`)
    }
    engine.deselect()

    // 5и. Delete во время трансформации удаляет фрагмент (+undo).
    engine.newDocument(64, 64, 'white')
    engine.addLayer('Del')
    engine.selectRect(10, 10, 20, 20, 'replace')
    engine.fillSelectedArea([0, 0.6, 0, 1])
    engine.liftSelection()
    engine.deleteFloating()
    c = engine.readComposite()
    if (!near(px(c.pixels, 64, 20, 20), [255, 255, 255, 255], 8)) {
      failures.push(`deleteFloating: ${px(c.pixels, 64, 20, 20).join(',')}`)
    }
    engine.undo()
    c = engine.readComposite()
    if (px(c.pixels, 64, 20, 20)[1]! < 100) {
      failures.push(`undo deleteFloating: ${px(c.pixels, 64, 20, 20).join(',')}`)
    }

    // 5к. convertToSmart: обычный слой таскается без потерь, undo возвращает.
    engine.newDocument(64, 64, 'white')
    engine.addLayer('Conv')
    engine.selectRect(10, 10, 20, 20, 'replace')
    engine.fillSelectedArea([0, 0, 1, 1])
    engine.deselect()
    const convId = engine.getDocumentJson()!.activeLayerId!
    if (!engine.convertToSmart(convId)) failures.push('convertToSmart не сработал')
    engine.setSmartTransform(convId, { dx: 22 }, { history: false })
    c = engine.readComposite()
    if (!near(px(c.pixels, 64, 15, 15), [255, 255, 255, 255], 8)) {
      failures.push(`smart-conv: старое место ${px(c.pixels, 64, 15, 15).join(',')}`)
    }
    if (px(c.pixels, 64, 40, 15)[2]! < 150) {
      failures.push(`smart-conv: новое место ${px(c.pixels, 64, 40, 15).join(',')}`)
    }
    engine.setSmartTransform(convId, { dx: 0 }, { history: false })
    c = engine.readComposite()
    if (px(c.pixels, 64, 15, 15)[2]! < 150) {
      failures.push(`smart-conv возврат: ${px(c.pixels, 64, 15, 15).join(',')}`)
    }

    // 5л. Стили размытия: гаусс расползается во все стороны, движение — вдоль угла.
    engine.newDocument(64, 64, 'white')
    engine.addLayer('Blur')
    engine.selectRect(24, 24, 16, 16, 'replace')
    engine.fillSelectedArea([1, 0, 0, 1])
    engine.deselect()
    const blurId = engine.getDocumentJson()!.activeLayerId!
    engine.setLayerStyles(blurId, { gaussianBlur: { enabled: true, radius: 8 } })
    c = engine.readComposite()
    // 3px правее квадрата: красный «дым» (green проседает); далёкий угол чист.
    if (px(c.pixels, 64, 43, 32)[1]! > 230) {
      failures.push(`гаусс-стиль: нет расплыва ${px(c.pixels, 64, 43, 32).join(',')}`)
    }
    if (!near(px(c.pixels, 64, 6, 6), [255, 255, 255, 255], 6)) {
      failures.push(`гаусс-стиль: залил фон ${px(c.pixels, 64, 6, 6).join(',')}`)
    }
    engine.setLayerStyles(blurId, { motionBlur: { enabled: true, distance: 30, angle: 0 } })
    c = engine.readComposite()
    // Горизонтальный смаз: справа тянется, снизу — нет.
    if (px(c.pixels, 64, 44, 32)[1]! > 235) {
      failures.push(`движение: нет смаза ${px(c.pixels, 64, 44, 32).join(',')}`)
    }
    if (px(c.pixels, 64, 32, 45)[1]! < 245) {
      failures.push(`движение: смаз поперёк угла ${px(c.pixels, 64, 32, 45).join(',')}`)
    }
    // Большой радиус идёт через даунсемплированный путь — расплыв на месте.
    engine.setLayerStyles(blurId, { gaussianBlur: { enabled: true, radius: 40 } })
    c = engine.readComposite()
    if (px(c.pixels, 64, 50, 32)[1]! > 240) {
      failures.push(`гаусс-40 (даунсемпл): ${px(c.pixels, 64, 50, 32).join(',')}`)
    }
    // Слой во весь холст после размытия не растворяется у краёв (clamp, как в PS).
    engine.fillActiveLayer([0, 0, 1, 1])
    engine.setLayerStyles(blurId, { gaussianBlur: { enabled: true, radius: 20 } })
    c = engine.readComposite()
    if (!near(px(c.pixels, 64, 1, 1), [0, 0, 255, 255], 8)) {
      failures.push(`гаусс растворил край холста: ${px(c.pixels, 64, 1, 1).join(',')}`)
    }
    engine.setLayerStyles(blurId, { motionBlur: { enabled: true, distance: 40, angle: 30 } })
    c = engine.readComposite()
    if (!near(px(c.pixels, 64, 1, 1), [0, 0, 255, 255], 8)) {
      failures.push(`движение растворило край холста: ${px(c.pixels, 64, 1, 1).join(',')}`)
    }
    engine.fillActiveLayer([1, 0, 0, 1])
    engine.setLayerStyles(blurId, undefined)

    // Кэш размытия: изменение пикселей слоя (version) обязано его сбросить.
    engine.setLayerStyles(blurId, { gaussianBlur: { enabled: true, radius: 8 } })
    engine.readComposite() // прогрев кэша
    engine.fillActiveLayer([0, 1, 0, 1])
    c = engine.readComposite()
    const cachePx = px(c.pixels, 64, 32, 32)
    if (cachePx[1]! < 150 || cachePx[0]! > 100) {
      failures.push(`кэш размытия не сброшен: ${cachePx.join(',')}`)
    }
    engine.setLayerStyles(blurId, undefined)
    c = engine.readComposite()
    if (px(c.pixels, 64, 32, 32)[1]! < 200) {
      failures.push(`снятие размытия: ${px(c.pixels, 64, 32, 32).join(',')}`)
    }

    // 5м. Наложение цвета: зелёный слой перекрашивается в синий, форма цела.
    engine.setLayerStyles(blurId, {
      colorOverlay: { enabled: true, color: '#0000ff', opacity: 1 },
    })
    c = engine.readComposite()
    const ovr = px(c.pixels, 64, 32, 32)
    if (ovr[2]! < 200 || ovr[1]! > 60) {
      failures.push(`наложение цвета: ${ovr.join(',')}`)
    }
    engine.setLayerStyles(blurId, {
      colorOverlay: { enabled: true, color: '#0000ff', opacity: 0.5 },
    })
    c = engine.readComposite()
    const ovr50 = px(c.pixels, 64, 32, 32)
    if (ovr50[2]! < 100 || ovr50[1]! < 100) {
      failures.push(`наложение цвета 50%: ${ovr50.join(',')}`)
    }

    // 5н. Смаз учитывает поворот объекта: слой на 90°, угол 0 → смаз вертикален.
    engine.newDocument(64, 64, 'white')
    engine.addLayer('Rot')
    engine.selectRect(24, 24, 16, 16, 'replace')
    engine.fillSelectedArea([1, 0, 0, 1])
    engine.deselect()
    const rotId = engine.getDocumentJson()!.activeLayerId!
    if (!engine.convertToSmart(rotId)) failures.push('смаз с поворотом: convertToSmart')
    engine.setSmartTransform(rotId, { rot: Math.PI / 2 }, { history: false })
    engine.setLayerStyles(rotId, { motionBlur: { enabled: true, distance: 30, angle: 0 } })
    c = engine.readComposite()
    if (px(c.pixels, 64, 32, 45)[1]! > 235) {
      failures.push(`смаз с поворотом: нет вертикального ${px(c.pixels, 64, 32, 45).join(',')}`)
    }
    if (px(c.pixels, 64, 45, 32)[1]! < 245) {
      failures.push(`смаз с поворотом: лишний горизонтальный ${px(c.pixels, 64, 45, 32).join(',')}`)
    }

    // 5о. Размер холста: кадрирование, undo, расширение.
    engine.newDocument(64, 64, 'white')
    engine.addLayer('R')
    engine.fillActiveLayer([1, 0, 0, 1])
    engine.resizeCanvas(32, 32, -16, -16)
    c = engine.readComposite()
    if (c.width !== 32 || !near(px(c.pixels, 32, 16, 16), [255, 0, 0, 255], 6)) {
      failures.push(`кадрирование: ${c.width}×${c.height} ${px(c.pixels, 32, 16, 16).join(',')}`)
    }
    engine.undo()
    c = engine.readComposite()
    if (c.width !== 64 || !near(px(c.pixels, 64, 8, 8), [255, 0, 0, 255], 6)) {
      failures.push(`undo размера холста: ${c.width}×${c.height} ${px(c.pixels, 64, 8, 8).join(',')}`)
    }
    engine.resizeCanvas(96, 80, 16, 8)
    c = engine.readComposite()
    if (
      c.width !== 96 ||
      c.height !== 80 ||
      !near(px(c.pixels, 96, 48, 40), [255, 0, 0, 255], 6) ||
      px(c.pixels, 96, 4, 4)[3]! !== 0
    ) {
      failures.push(
        `расширение холста: угол ${px(c.pixels, 96, 4, 4).join(',')}, центр ${px(c.pixels, 96, 48, 40).join(',')}`,
      )
    }

    // 5. Ластик по заполненному слою.
    engine.newDocument(32, 32, 'transparent')
    engine.fillActiveLayer([0, 0, 1, 1])
    engine.beginStroke(
      'erase',
      { ...DEFAULT_BRUSH, size: 16, hardness: 1, pressureSize: false },
      [0, 0, 0, 1],
      { x: 16, y: 16, pressure: 0.5 },
    )
    engine.endStroke()
    c = engine.readComposite()
    const erased = px(c.pixels, 32, 16, 16)
    if (erased[3]! > 10) {
      failures.push(`ластик: alpha=${erased[3]}`)
    }
  } catch (e) {
    failures.push(`исключение: ${String(e)}`)
  } finally {
    engine.dispose()
  }

  return { pass: failures.length === 0, failures }
}
