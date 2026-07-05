export interface GlInfo {
  webgl2: boolean
  renderer: string
  vendor: string
  maxTextureSize: number
  /** SwiftShader/llvmpipe и т.п. — работает, но медленно. */
  software: boolean
}

export function collectGlInfo(): GlInfo {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) {
    return { webgl2: false, renderer: '', vendor: '', maxTextureSize: 0, software: true }
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const renderer = String(
    dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
  )
  const vendor = String(
    dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  )
  const software = /swiftshader|llvmpipe|software/i.test(`${renderer} ${vendor}`)

  return {
    webgl2: true,
    renderer,
    vendor,
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    software,
  }
}
