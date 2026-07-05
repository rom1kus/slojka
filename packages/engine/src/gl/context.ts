export interface GlCaps {
  maxTextureSize: number
  renderer: string
  software: boolean
}

export class GlContext {
  readonly gl: WebGL2RenderingContext
  readonly caps: GlCaps

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Композитор сам управляет premultiplied-alpha по всему конвейеру.
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL2 недоступен')
    this.gl = gl

    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    )
    this.caps = {
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      renderer,
      software: /swiftshader|llvmpipe|software/i.test(renderer),
    }

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    // КРИТИЧНО для R8 (маски/выделения): дефолтное выравнивание строк = 4
    // молча ломает upload и readPixels на ширинах, не кратных 4 —
    // выделение SAM «исчезало» на документах произвольного размера.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
  }
}
