/** Преобразования пикселей: движок держит premultiplied, PNG — нет. */

export function unpremultiply(premult: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(premult.length)
  for (let i = 0; i < premult.length; i += 4) {
    const a = premult[i + 3]!
    if (a === 0) continue
    const k = 255 / a
    out[i] = premult[i]! * k
    out[i + 1] = premult[i + 1]! * k
    out[i + 2] = premult[i + 2]! * k
    out[i + 3] = a
  }
  return out
}

/** RGBA premult → PNG-байты. */
export async function pixelsToPng(pixels: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(unpremultiply(pixels), w, h), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** R8-маска → серый PNG. */
export async function maskToPng(mask: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]!
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

export async function pngToImageBitmap(data: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([data as BlobPart]))
}

/** Байты → base64 через FileReader: без многомегабайтных промежуточных строк. */
export async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(new Blob([bytes as BlobPart]))
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/** PNG (серый) → R8-байты нужного размера (кроп/паддинг до w×h). */
export async function pngToMask(data: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const bmp = await pngToImageBitmap(data)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = img.data[i * 4]!
  return out
}

/** ImageBitmap → premultiplied RGBA байты (для loadDocument). */
export function bitmapToPremult(bmp: ImageBitmap, w: number, h: number): Uint8Array {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < out.length; i += 4) {
    const a = img.data[i + 3]!
    const k = a / 255
    out[i] = Math.round(img.data[i]! * k)
    out[i + 1] = Math.round(img.data[i + 1]! * k)
    out[i + 2] = Math.round(img.data[i + 2]! * k)
    out[i + 3] = a
  }
  return out
}
