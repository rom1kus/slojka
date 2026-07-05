import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { BRAND, type Lang } from '@slojka/shared'
import { getLanguage, setLanguage, settings } from './settings'
import { buildMenu } from './menu'
import { listFontFamilies } from './fonts'
import { registerFileIpc } from './files'
import { registerAiIpc, sidecar } from './sidecar'
import { mcpBridge } from './mcpBridge'
import { registerTerminalIpc } from './ptyHost'
import { registerResScheme, registerResProtocol } from './resProtocol'

// Имя приложения = BRAND.id: определяет userData (~/.config/slojka) и пр.
app.setName(BRAND.id)

// Привилегированные схемы регистрируются строго до whenReady.
registerResScheme()

const isSmoke = process.argv.includes('--smoke')
const isDev = !!process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const winState = settings.get('window')

  mainWindow = new BrowserWindow({
    title: BRAND.name,
    width: winState.width,
    height: winState.height,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b1b1f',
    show: false,
    // Кастомный титлбар в теме приложения; нативное меню остаётся
    // установленным (невидимым) — оно обслуживает горячие клавиши.
    frame: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox выключен осознанно: ESM-preload; узкий API через contextBridge.
      sandbox: false,
      additionalArguments: [
        ...(isSmoke ? ['--slojka-smoke'] : []),
        // Долгий этап смоука (инференс удаления фона) — только по запросу.
        ...(isSmoke && process.env['SLOJKA_SMOKE_REMOVEBG'] ? ['--slojka-smoke-removebg'] : []),
      ],
    },
  })

  if (winState.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', () => {
    if (!mainWindow) return
    const [width, height] = mainWindow.getSize()
    settings.set('window', {
      width,
      height,
      maximized: mainWindow.isMaximized(),
    })
  })

  buildMenu(mainWindow, getLanguage())

  if (isDev) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get-language', () => getLanguage())

  ipcMain.handle('settings:set-language', (_e, lang: Lang) => {
    setLanguage(lang)
    if (mainWindow) buildMenu(mainWindow, getLanguage())
  })

  ipcMain.handle('fonts:list', () => listFontFamilies())

  ipcMain.handle('settings:get', (_e, key: string) => settings.get(key))
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    settings.set(key, value)
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle('app:info', () => ({
    name: BRAND.name,
    version: BRAND.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }))
}

/**
 * Смоук-режим (npm run smoke): ждём от renderer отчёт о WebGL2 и выходим.
 * Код выхода 0 + строка SMOKE_RESULT — платформа пригодна.
 */
function setupSmoke(): void {
  // Инференс удаления фона на CPU долгий — с ним лимит щедрее.
  const limitMs = process.env['SLOJKA_SMOKE_REMOVEBG'] ? 180_000 : 20_000
  const timeout = setTimeout(() => {
    console.error(`SMOKE_FAIL timeout: renderer не отчитался за ${limitMs / 1000}с`)
    app.exit(1)
  }, limitMs)

  ipcMain.once('smoke:report', (_e, info: unknown) => {
    clearTimeout(timeout)
    console.log(`SMOKE_RESULT ${JSON.stringify(info)}`)
    // Скриншот окна для визуальной проверки UI.
    const shotPath = process.env['SLOJKA_SMOKE_SHOT']
    if (shotPath && mainWindow) {
      setTimeout(() => {
        mainWindow!.webContents
          .capturePage()
          .then((img) => writeFile(shotPath, img.toPNG()))
          .catch((e) => console.error('SMOKE_SHOT_FAIL', e))
          .finally(() => app.exit(0))
      }, 400)
    } else {
      app.exit(0)
    }
  })
}

app.whenReady().then(() => {
  registerResProtocol()
  registerIpc()
  registerFileIpc(
    () => mainWindow,
    () => getLanguage(),
  )
  registerAiIpc(() => mainWindow)
  registerTerminalIpc(() => mainWindow)
  void mcpBridge
    .start(() => mainWindow)
    .catch((e: unknown) => console.warn('[mcp] мост не запустился:', e))
  // Локальный ИИ включён ранее — поднимаем sidecar в фоне.
  if (settings.get('aiEnabled')) {
    void sidecar
      .enable()
      .catch((e: unknown) => console.warn('[sidecar] автозапуск не удался:', e))
  }
  if (isSmoke) setupSmoke()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  mcpBridge.stop()
})
