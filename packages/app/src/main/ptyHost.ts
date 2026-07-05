import { app, ipcMain, type BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { settings } from './settings'

/**
 * Встроенный терминал (xterm.js в renderer ↔ node-pty здесь) для Claude Code.
 * node-pty — optionalDependency: если нативный модуль не собрался,
 * терминал честно говорит об этом, остальное приложение не страдает.
 */

type PtyModule = typeof import('node-pty')

let pty: PtyModule | null = null
let ptyError: string | null = null
try {
  pty = (await import('node-pty')) as PtyModule
} catch (e) {
  ptyError = e instanceof Error ? e.message : String(e)
}

interface TermSession {
  proc: import('node-pty').IPty
}

const sessions = new Map<number, TermSession>()
let nextId = 1

function mcpServerEntry(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'mcp-server', 'index.cjs')
    : join(app.getAppPath(), '..', 'mcp-server', 'src', 'index.js')
}

/** Гарантирует .mcp.json с сервером slojka в рабочей директории терминала. */
async function ensureMcpJson(cwd: string): Promise<void> {
  const path = join(cwd, '.mcp.json')
  let config: { mcpServers?: Record<string, unknown> } = {}
  try {
    config = JSON.parse((await readFile(path)).toString('utf8'))
  } catch {
    /* нового файла достаточно */
  }
  config.mcpServers ??= {}
  config.mcpServers['slojka'] = {
    command: 'node',
    args: [mcpServerEntry()],
  }
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
}

/**
 * Команда запуска терминала с claude.
 * POSIX: НЕ логин-шелл (-l) — профиль пользователя запускает xinit и claude
 * стартует на ~15 с позже; нет claude — остаёмся в обычном шелле.
 * Windows: cmd /k — при отсутствии claude остаётся интерактивный cmd.
 */
function shellCommand(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/k', 'claude'] }
  }
  const shell = process.env['SHELL'] ?? 'bash'
  return { file: shell, args: ['-c', 'claude || exec $SHELL'] }
}

/**
 * Окружение терминала: PATH дополняется типовыми bin-директориями (claude
 * ставится в ~/.local/bin / %APPDATA%\npm), прокси — из настроек
 * (⚙ Настройки → Сеть); пустое значение = переменная не задаётся.
 */
function terminalEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) }
  const home = app.getPath('home')
  const extraPath =
    process.platform === 'win32'
      ? [join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'npm')]
      : [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')]
  // На Windows ключ может называться Path — дополняем существующий, не плодим дубликат.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = [...extraPath, env[pathKey] ?? ''].join(delimiter)

  const proxyHttp = settings.get('proxyHttp')
  const proxyHttps = settings.get('proxyHttps')
  if (proxyHttp) {
    env['HTTP_PROXY'] = proxyHttp
    env['http_proxy'] = proxyHttp
  }
  if (proxyHttps) {
    env['HTTPS_PROXY'] = proxyHttps
    env['https_proxy'] = proxyHttps
  }
  return env
}

export function registerTerminalIpc(getWin: () => BrowserWindow | null): void {
  // pty дошлёт данные/exit и после закрытия окна — слать только в живое,
  // иначе «Object has been destroyed» при выходе с открытым терминалом.
  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWin()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(channel, ...args)
    } catch {
      /* окно умерло между проверкой и send */
    }
  }

  ipcMain.handle('term:available', () => ({ ok: pty !== null, error: ptyError }))

  ipcMain.handle(
    'term:start',
    async (_e, opts: { filePath: string | null; cols: number; rows: number }) => {
      if (!pty) throw new Error(`node-pty недоступен: ${ptyError}`)
      const cwd = projectDirFor(opts.filePath) ?? app.getPath('home')
      await ensureMcpJson(cwd)

      const { file, args } = shellCommand()
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd,
        env: terminalEnv(),
      })
      const id = nextId++
      sessions.set(id, { proc })

      proc.onData((data) => send('term:data', id, data))
      proc.onExit(({ exitCode }) => {
        sessions.delete(id)
        send('term:exit', id, exitCode)
      })
      return { id, cwd }
    },
  )

  ipcMain.on('term:input', (_e, id: number, data: string) => {
    sessions.get(id)?.proc.write(data)
  })

  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => {
    sessions.get(id)?.proc.resize(cols, rows)
  })

  ipcMain.on('term:kill', (_e, id: number) => {
    sessions.get(id)?.proc.kill()
    sessions.delete(id)
  })

  app.on('before-quit', () => {
    for (const s of sessions.values()) s.proc.kill()
    sessions.clear()
  })
}

/** Директория проекта для терминала: папка открытого файла. */
export function projectDirFor(filePath: string | null): string | null {
  return filePath ? dirname(filePath) : null
}
