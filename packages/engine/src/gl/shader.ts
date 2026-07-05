export class Program {
  readonly prog: WebGLProgram
  private uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(
    private gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    readonly label: string,
  ) {
    const vs = this.compile(gl.VERTEX_SHADER, vertSrc)
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Линковка шейдера "${label}": ${gl.getProgramInfoLog(prog)}`)
    }
    this.prog = prog
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl
    const sh = gl.createShader(type)
    if (!sh) throw new Error('createShader вернул null')
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`Компиляция шейдера "${this.label}": ${gl.getShaderInfoLog(sh)}`)
    }
    return sh
  }

  use(): void {
    this.gl.useProgram(this.prog)
  }

  loc(name: string): WebGLUniformLocation | null {
    let l = this.uniforms.get(name)
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name)
      this.uniforms.set(name, l)
    }
    return l
  }

  setInt(name: string, v: number): void {
    this.gl.uniform1i(this.loc(name), v)
  }
  setFloat(name: string, v: number): void {
    this.gl.uniform1f(this.loc(name), v)
  }
  setVec2(name: string, x: number, y: number): void {
    this.gl.uniform2f(this.loc(name), x, y)
  }
  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w)
  }
}
