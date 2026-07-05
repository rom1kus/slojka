import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { settings } from './settings'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BRAND } from '@slojka/shared'

export interface AiProgress {
  stage: 'venv' | 'pip-base' | 'pip-ai' | 'checkpoint' | 'start' | 'done' | 'error'
  message: string
  /** 0..1, если известен. */
  pct?: number
}

const CHECKPOINT_SIZES = ['tiny', 'small', 'base_plus', 'large']

function dataDir(): string {
  // Linux: ~/.local/share/slojka (переживает переустановки); иначе userData.
  if (process.platform === 'linux') {
    return join(app.getPath('home'), '.local', 'share', BRAND.id)
  }
  return app.getPath('userData')
}

function venvDir(): string {
  return join(dataDir(), 'venv')
}

function modelsDir(): string {
  return join(dataDir(), 'models')
}

function venvBin(name: string): string {
  // Windows кладёт исполняемые файлы venv в Scripts\*.exe, POSIX — в bin/.
  return process.platform === 'win32'
    ? join(venvDir(), 'Scripts', `${name}.exe`)
    : join(venvDir(), 'bin', name)
}

function sidecarSrcDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'sidecar')
    : join(app.getAppPath(), '..', '..', 'sidecar')
}

/**
 * Жизненный цикл Python-sidecar: бутстрап venv, запуск с handshake,
 * health-poll, рестарт с backoff, прокси запросов с Bearer-токеном.
 * Ядро редактора никогда от него не зависит.
 */
class SidecarManager {
  private proc: ChildProcess | null = null
  private port = 0
  private token = ''
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restarts = 0
  private getWin: () => BrowserWindow | null = () => null

  state: 'absent' | 'starting' | 'ready' | 'error' = 'absent'

  init(getWin: () => BrowserWindow | null): void {
    this.getWin = getWin
  }

  private progress(p: AiProgress): void {
    const win = this.getWin()
    if (win && !win.isDestroyed()) win.webContents.send('ai:progress', p)
  }

  private notifyState(): void {
    // При выходе окно уже уничтожено — send кидал «Object has been destroyed».
    const win = this.getWin()
    if (win && !win.isDestroyed()) win.webContents.send('ai:state', this.state)
  }

  async findPython(): Promise<string | null> {
    // Windows: py-лаунчер и python из python.org/Store; POSIX: python3.x.
    const candidates =
      process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3.11', 'python3.12', 'python3.13', 'python3']
    for (const cmd of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(cmd, [
          '-c',
          'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)',
        ])
        p.on('error', () => resolve(false))
        p.on('exit', (code) => resolve(code === 0))
      })
      if (ok) return cmd
    }
    return null
  }

  async baseInstalled(): Promise<boolean> {
    try {
      await access(venvBin('python'))
      const code = await this.run(venvBin('python'), ['-c', 'import fastapi, uvicorn, PIL'])
      return code === 0
    } catch {
      return false
    }
  }

  /** Бутстрап: venv + базовые зависимости + запуск. */
  async enable(): Promise<void> {
    const python = await this.findPython()
    if (!python) throw new Error('Не найден Python ≥ 3.10 (нужен python3.11)')

    if (!(await this.baseInstalled())) {
      this.progress({ stage: 'venv', message: 'Создание окружения Python…' })
      await mkdir(dataDir(), { recursive: true })
      await this.runOrThrow(python, ['-m', 'venv', venvDir()], 'создание venv')

      this.progress({ stage: 'pip-base', message: 'Установка базовых зависимостей (~15 МБ)…' })
      await this.runOrThrow(
        venvBin('pip'),
        ['install', '--no-input', '-r', join(sidecarSrcDir(), 'requirements-base.txt')],
        'установка базовых зависимостей',
        (line) => this.progress({ stage: 'pip-base', message: line }),
      )
    }
    await this.start()
    // Модель уже скачана и torch установлен? Грузим сразу —
    // без этого SAM «выключался» после каждого перезапуска приложения.
    await this.autoLoadSam().catch((e: unknown) =>
      console.warn('[sidecar] автозагрузка SAM:', e),
    )
    this.progress({ stage: 'done', message: 'Локальный ИИ готов' })
  }

  /** SLOJKA_READY печатается до старта uvicorn — ждём, пока HTTP оживёт. */
  private async waitReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        await this.proxy('/health')
        return
      } catch (e) {
        if (Date.now() > deadline) throw e
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }

  /** Автозагрузка SAM: если чекпойнт на диске и sam2 установлен. */
  async autoLoadSam(): Promise<void> {
    const size = settings.get('samModel')
    try {
      await access(join(modelsDir(), `sam2.1_hiera_${size}.pt`))
    } catch {
      return // модель не скачана — грузить нечего
    }
    await this.waitReady()
    const status = (await this.proxy('/sam/status')) as { installed: boolean; loaded: boolean }
    if (!status.installed || status.loaded) return
    this.progress({ stage: 'start', message: 'Загрузка модели SAM…' })
    await this.proxy('/sam/load', { model_size: size })
    this.notifyState() // UI перезапросит статус и включит инструмент
  }

  /** Установка SAM: torch cu124 (~2.5 ГБ!) + sam2. Вызывается только после согласия. */
  async installSam(): Promise<void> {
    this.progress({ stage: 'pip-ai', message: 'Установка PyTorch + SAM 2.1 (~2.5 ГБ)…' })
    await this.runOrThrow(
      venvBin('pip'),
      ['install', '--no-input', '-r', join(sidecarSrcDir(), 'requirements-ai.txt')],
      'установка torch/sam2',
      (line) => this.progress({ stage: 'pip-ai', message: line }),
    )
    // Новые пакеты подхватятся при следующем /sam/load (lazy import).
  }

  /**
   * Скачивание чекпойнта делегируется sidecar: его httpx уважает системные
   * прокси (HTTP_PROXY/HTTPS_PROXY), в отличие от fetch в main-процессе.
   */
  async downloadCheckpoint(size: string): Promise<void> {
    if (!CHECKPOINT_SIZES.includes(size)) throw new Error(`Неизвестная модель: ${size}`)
    const started = (await this.proxy('/sam/download', { model_size: size })) as {
      already?: boolean
    }
    if (started.already) return

    for (;;) {
      await new Promise((r) => setTimeout(r, 700))
      const st = (await this.proxy(`/sam/download-status/${size}`)) as {
        status: string
        received?: number
        total?: number
        error?: string
      }
      if (st.status === 'done') {
        this.progress({ stage: 'checkpoint', message: 'Модель скачана', pct: 1 })
        return
      }
      if (st.status === 'error') throw new Error(`Скачивание модели: ${st.error}`)
      const rec = Math.round((st.received ?? 0) / 1e6)
      const tot = Math.round((st.total ?? 0) / 1e6)
      this.progress({
        stage: 'checkpoint',
        message: `Скачивание модели: ${rec}${tot ? ` / ${tot}` : ''} МБ`,
        ...(st.total ? { pct: (st.received ?? 0) / st.total } : {}),
      })
    }
  }

  async listCheckpoints(): Promise<string[]> {
    try {
      const files = await readdir(modelsDir())
      return files
        .filter((f) => f.startsWith('sam2.1_hiera_') && f.endsWith('.pt'))
        .map((f) => f.replace('sam2.1_hiera_', '').replace('.pt', ''))
    } catch {
      return []
    }
  }

  /**
   * Добить осиротевший sidecar прошлой сессии (dev-перезапуски, крэши).
   * Проверка «это точно наш процесс» есть только на Linux (/proc/cmdline);
   * на других платформах PID не убиваем вслепую — там страхует
   * parent-watchdog самого sidecar.
   */
  private async killStale(): Promise<void> {
    const pidFile = join(dataDir(), 'sidecar.pid')
    if (process.platform === 'linux') {
      try {
        const pid = Number((await readFile(pidFile)).toString().trim())
        if (pid > 1) {
          const cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString()
          if (cmdline.includes('slojka_sidecar')) {
            process.kill(pid, 'SIGKILL')
            console.warn(`[sidecar] добит осиротевший процесс ${pid}`)
          }
        }
      } catch {
        /* нет файла/процесса — норм */
      }
    }
    await unlink(pidFile).catch(() => undefined)
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.state = 'starting'
    this.notifyState()
    this.token = randomBytes(24).toString('hex')
    await this.killStale()

    const proc = spawn(
      venvBin('python'),
      ['-m', 'slojka_sidecar', '--port', '0', '--parent-pid', String(process.pid)],
      {
        cwd: sidecarSrcDir(),
        env: {
          ...process.env,
          SLOJKA_TOKEN: this.token,
          PYTHONPATH: sidecarSrcDir(),
          // Обе стороны (main и python) обязаны видеть одни и те же
          // jobs.db/models/кэши — путь задаёт main, а не угадывает python.
          SLOJKA_DATA_DIR: dataDir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.proc = proc
    void writeFile(join(dataDir(), 'sidecar.pid'), String(proc.pid ?? 0)).catch(() => undefined)

    proc.stderr?.on('data', (d: Buffer) => console.warn('[sidecar]', d.toString().trim()))
    proc.on('exit', (code) => {
      console.warn(`[sidecar] завершился с кодом ${code}`)
      this.proc = null
      this.stopHealth()
      if (this.state !== 'absent') {
        this.state = 'error'
        this.notifyState()
        // Авторестарт с backoff (максимум 3 попытки подряд).
        if (this.restarts < 3) {
          this.restarts++
          setTimeout(() => void this.start().catch(() => undefined), 2000 * this.restarts)
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sidecar не ответил за 30с')), 30_000)
      proc.stdout?.on('data', (d: Buffer) => {
        const line = d.toString()
        const m = line.match(/SLOJKA_READY (\{.*\})/)
        if (m) {
          clearTimeout(timeout)
          this.port = (JSON.parse(m[1]!) as { port: number }).port
          resolve()
        }
      })
      proc.on('error', (e) => {
        clearTimeout(timeout)
        reject(e)
      })
    })

    // READY печатается до старта uvicorn — дожидаемся живого HTTP,
    // иначе первый же proxy (ключ polza, автозагрузка SAM) получает
    // ECONNREFUSED.
    this.state = 'ready'
    await this.waitReady().catch((e: unknown) => {
      console.warn('[sidecar] HTTP не поднялся:', e)
    })
    this.restarts = 0
    this.notifyState()
    this.startHealth()
    await this.pushPolzaKey()
  }

  /** Передаёт сохранённый API-ключ polza в sidecar (ключ живёт только в его памяти). */
  async pushPolzaKey(): Promise<void> {
    const key = readPolzaKey()
    if (key && this.state === 'ready') {
      await this.waitReady().catch(() => undefined)
      await this.proxy('/polza/config', { api_key: key }).catch((e: unknown) =>
        console.warn('[sidecar] не удалось передать ключ polza:', e),
      )
    }
  }

  stop(): void {
    this.state = 'absent'
    this.stopHealth()
    const proc = this.proc
    this.proc = null
    if (proc) {
      proc.kill('SIGTERM')
      // Если Python занят (грузит модель) и не вышел — добиваем:
      // память с torch+SAM должна освобождаться сразу.
      const pid = proc.pid
      setTimeout(() => {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* уже вышел */
          }
        }
      }, 3000)
    }
    void unlink(join(dataDir(), 'sidecar.pid')).catch(() => undefined)
    this.notifyState()
  }

  /** Прокси запроса в sidecar (renderer не знает ни порт, ни токен). */
  async proxy(path: string, body?: unknown): Promise<unknown> {
    if (this.state !== 'ready') throw new Error('Sidecar не запущен')
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = (await res.json()) as { detail?: string }
    if (!res.ok) throw new Error(data.detail ?? `sidecar HTTP ${res.status}`)
    return data
  }

  private startHealth(): void {
    this.healthTimer = setInterval(() => {
      void this.proxy('/health').catch(() => {
        // exit-handler разберётся с рестартом; здесь просто фиксируем.
        console.warn('[sidecar] health-check не прошёл')
      })
    }, 10_000)
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private run(cmd: string, args: string[], onLine?: (l: string) => void): Promise<number> {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const feed = (d: Buffer): void => {
        const line = d.toString().trim().split('\n').at(-1)?.trim()
        if (line && onLine) onLine(line.slice(0, 120))
      }
      p.stdout?.on('data', feed)
      p.stderr?.on('data', feed)
      p.on('error', () => resolve(-1))
      p.on('exit', (code) => resolve(code ?? -1))
    })
  }

  private async runOrThrow(
    cmd: string,
    args: string[],
    what: string,
    onLine?: (l: string) => void,
  ): Promise<void> {
    const code = await this.run(cmd, args, onLine)
    if (code !== 0) throw new Error(`Не удалось: ${what} (код ${code})`)
  }
}

export const sidecar = new SidecarManager()

function readPolzaKey(): string | null {
  const enc = settings.get('polzaKeyEnc') as string | undefined
  if (!enc) return null
  try {
    const buf = Buffer.from(enc, 'base64')
    if (settings.get('polzaKeyPlain')) return buf.toString('utf8')
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export function registerAiIpc(getWin: () => BrowserWindow | null): void {
  sidecar.init(getWin)

  ipcMain.handle('ai:status', async () => {
    const python = await sidecar.findPython()
    const base = await sidecar.baseInstalled()
    let sam: unknown = null
    if (sidecar.state === 'ready') {
      sam = await sidecar.proxy('/sam/status').catch(() => null)
    }
    return {
      python,
      baseInstalled: base,
      state: sidecar.state,
      sam,
      checkpoints: await sidecar.listCheckpoints(),
    }
  })

  ipcMain.handle('ai:enable', async () => {
    await sidecar.enable()
  })

  ipcMain.handle('ai:disable', () => {
    sidecar.stop()
  })

  ipcMain.handle('ai:install-sam', async (_e, size: string) => {
    await sidecar.installSam()
    await sidecar.downloadCheckpoint(size)
    await sidecar.proxy('/sam/load', { model_size: size })
  })

  ipcMain.handle('ai:sam-load', async (_e, size: string) => {
    await sidecar.downloadCheckpoint(size)
    return sidecar.proxy('/sam/load', { model_size: size })
  })

  ipcMain.handle('ai:sam-set-image', (_e, pngBase64: string) =>
    sidecar.proxy('/sam/set-image', { png_base64: pngBase64 }),
  )

  ipcMain.handle('ai:sam-predict', (_e, req: unknown) => sidecar.proxy('/sam/predict', req))

  // ── Polza ──
  ipcMain.handle('polza:set-key', async (_e, key: string) => {
    if (!key) {
      settings.delete('polzaKeyEnc')
    } else {
      const enc = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(key).toString('base64')
        : Buffer.from(key, 'utf8').toString('base64') // фолбэк без keyring
      settings.set('polzaKeyEnc', enc)
      settings.set('polzaKeyPlain', !safeStorage.isEncryptionAvailable())
    }
    await sidecar.pushPolzaKey()
  })

  ipcMain.handle('polza:has-key', () => readPolzaKey() !== null)

  ipcMain.handle('polza:generate', (_e, req: unknown) => sidecar.proxy('/polza/generate', req))
  ipcMain.handle('polza:jobs', () => sidecar.proxy('/polza/jobs'))
  ipcMain.handle('polza:cancel', (_e, id: string) => sidecar.proxy('/polza/cancel', { id }))
  ipcMain.handle('polza:remove', (_e, id: string) => sidecar.proxy('/polza/remove', { id }))
  ipcMain.handle('polza:clear-finished', () => sidecar.proxy('/polza/clear-finished', {}))
  ipcMain.handle('polza:result', (_e, id: string, index: number) =>
    sidecar.proxy('/polza/result', { id, index }),
  )
  ipcMain.handle('polza:models', () => sidecar.proxy('/polza/models'))

  ipcMain.handle('ai:delete-data', async () => {
    sidecar.stop()
    await rm(venvDir(), { recursive: true, force: true })
    await rm(modelsDir(), { recursive: true, force: true })
  })

  app.on('before-quit', () => sidecar.stop())
}
