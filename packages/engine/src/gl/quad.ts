/**
 * Единственный VAO на весь движок: квад 0..1, позиционируемый юниформой uRect
 * (в NDC: x0, y0, ширина, высота; высота может быть отрицательной —
 * так present-проход переворачивает Y).
 */
export class Quad {
  private vao: WebGLVertexArrayObject

  constructor(private gl: WebGL2RenderingContext) {
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.vao = vao
  }

  draw(): void {
    const gl = this.gl
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }
}

export const FULL_RECT: readonly [number, number, number, number] = [-1, -1, 2, 2]
