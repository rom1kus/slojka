import { Texture } from './texture'

export class Fbo {
  readonly fbo: WebGLFramebuffer

  constructor(
    private gl: WebGL2RenderingContext,
    public texture: Texture,
  ) {
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`FBO неполон: 0x${status.toString(16)}`)
    }
    this.fbo = fbo
  }

  /** Привязывает FBO и настраивает viewport под его текстуру. */
  bind(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.texture.width, this.texture.height)
  }

  /** Переназначает color attachment (для свопа текстур слой↔scratch). */
  attach(texture: Texture): void {
    const gl = this.gl
    this.texture = texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.tex, 0)
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl
    this.bind()
    gl.clearColor(r, g, b, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /**
   * Чтение пикселей области. y — в конвенции документа (строка 0 = верх),
   * что совпадает с texel-строками: переворот не нужен.
   */
  readPixels(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    const chans = this.texture.format === 'rgba8' ? 4 : 1
    const fmt = this.texture.format === 'rgba8' ? gl.RGBA : gl.RED
    const out = new Uint8Array(w * h * chans)
    gl.readPixels(x, y, w, h, fmt, gl.UNSIGNED_BYTE, out)
    return out
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.fbo)
  }
}
