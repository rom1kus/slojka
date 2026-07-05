/**
 * Текстуры слоёв: RGBA8, premultiplied alpha.
 * Конвенция ориентации: texel-строка 0 == верхняя строка документа.
 * Все внутренние проходы используют её; переворот происходит только
 * в present-проходе (см. compositor).
 */
export class Texture {
  readonly tex: WebGLTexture

  constructor(
    private gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    /** gl.RGBA8 (слои), gl.R8 (маски, буфер штриха) или gl.RG32F (поле JFA). */
    readonly format: 'rgba8' | 'r8' | 'rg32f' = 'rgba8',
  ) {
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    const internal = format === 'rgba8' ? gl.RGBA8 : format === 'r8' ? gl.R8 : gl.RG32F
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height)
    // 32F нефильтруем без отдельного расширения — только NEAREST
    // (JFA и так сэмплирует точечно).
    const filter = format === 'rg32f' ? gl.NEAREST : gl.LINEAR
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.tex = tex
  }

  upload(data: Uint8Array, x = 0, y = 0, w = this.width, h = this.height): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    const fmt = this.format === 'rgba8' ? gl.RGBA : gl.RED
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, fmt, gl.UNSIGNED_BYTE, data)
  }

  uploadImage(source: TexImageSource, premultiply = false): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    const fmt = this.format === 'rgba8' ? gl.RGBA : gl.RED
    if (premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fmt, gl.UNSIGNED_BYTE, source)
    if (premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }

  bind(unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
  }

  /** Переключение фильтрации (NEAREST на большом зуме — резкие пиксели). */
  setMagFilter(mode: 'linear' | 'nearest'): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      mode === 'nearest' ? gl.NEAREST : gl.LINEAR,
    )
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex)
  }

  get bytes(): number {
    return this.width * this.height * (this.format === 'rgba8' ? 4 : 1)
  }
}
