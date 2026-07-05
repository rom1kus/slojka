import { app, ipcMain, type BrowserWindow } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { BRAND } from '@slojka/shared'

/**
 * WS-мост для MCP: пока приложение запущено, слушает 127.0.0.1 и пишет
 * файл ~/.config/slojka/mcp-bridge.json {port, token, pid}. Процесс
 * mcp-server (stdio, его запускает claude CLI) читает файл, подключается
 * и форвардит вызовы инструментов сюда; исполняет их renderer.
 */

interface PendingCall {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CALL_TIMEOUT_MS = 120_000

export function bridgeFilePath(): string {
  // Фиксированный путь, независимый от Electron: mcp-server его знает сам.
  return join(app.getPath('appData'), BRAND.id, 'mcp-bridge.json')
}

class McpBridge {
  private wss: WebSocketServer | null = null
  private token = ''
  private pending = new Map<string, PendingCall>()
  private seq = 0
  private getWin: () => BrowserWindow | null = () => null

  async start(getWin: () => BrowserWindow | null): Promise<void> {
    this.getWin = getWin
    this.token = randomBytes(24).toString('hex')
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })

    await new Promise<void>((resolve) => this.wss!.once('listening', resolve))
    const addr = this.wss.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    this.wss.on('connection', (ws) => this.onConnection(ws))

    await mkdir(join(app.getPath('appData'), BRAND.id), { recursive: true })
    await writeFile(
      bridgeFilePath(),
      JSON.stringify({ port, token: this.token, pid: process.pid }),
      'utf8',
    )

    ipcMain.on('mcp:result', (_e, id: string, result: unknown, error: string | null) => {
      const call = this.pending.get(id)
      if (!call) return
      this.pending.delete(id)
      clearTimeout(call.timer)
      if (error) call.reject(new Error(error))
      else call.resolve(result)
    })
  }

  private onConnection(ws: WebSocket): void {
    let authed = false
    ws.on('message', (raw: Buffer) => {
      let msg: { id?: string; token?: string; tool?: string; args?: unknown }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.close()
        return
      }
      if (!authed) {
        if (msg.token === this.token) {
          authed = true
          ws.send(JSON.stringify({ ok: true }))
        } else {
          ws.close()
        }
        return
      }
      if (!msg.id || !msg.tool) return
      void this.dispatch(msg.tool, msg.args)
        .then((result) => ws.send(JSON.stringify({ id: msg.id, result })))
        .catch((e: Error) => ws.send(JSON.stringify({ id: msg.id, error: e.message })))
    })
  }

  /** Отправляет вызов в renderer и ждёт ответ. */
  private dispatch(tool: string, args: unknown): Promise<unknown> {
    const win = this.getWin()
    if (!win) return Promise.reject(new Error('Окно редактора не открыто'))
    const id = `${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`таймаут инструмента ${tool}`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      win.webContents.send('mcp:call', id, tool, args)
    })
  }

  stop(): void {
    this.wss?.close()
    // Синхронно: before-quit не ждёт промисов.
    try {
      unlinkSync(bridgeFilePath())
    } catch {
      /* файла может не быть */
    }
  }
}

export const mcpBridge = new McpBridge()
