import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { app } from 'electron'
import { BRAND, t, type Lang } from '@slojka/shared'

export interface OpenedFile {
  path: string
  name: string
  data: ArrayBuffer
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp']

function brushesDir(): string {
  return join(app.getPath('userData'), 'brushes')
}

/**
 * Файловый мост: renderer не имеет доступа к fs — все диалоги и диск здесь.
 * Данные ходят как ArrayBuffer через structured clone.
 */
export function registerFileIpc(getWin: () => BrowserWindow | null, getLang: () => Lang): void {
  ipcMain.handle('file:open-document', async (): Promise<OpenedFile | null> => {
    const win = getWin()
    if (!win) return null
    const _ = (k: string) => t(getLang(), k)
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        {
          name: _('files.allSupported'),
          extensions: [BRAND.fileExt.slice(1), 'ora', 'psd', ...IMAGE_EXTS],
        },
        { name: BRAND.nameLatin, extensions: [BRAND.fileExt.slice(1)] },
        { name: 'OpenRaster', extensions: ['ora'] },
        { name: 'Photoshop', extensions: ['psd'] },
        { name: _('files.images'), extensions: IMAGE_EXTS },
      ],
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    const buf = await readFile(path)
    return { path, name: basename(path), data: bufToArrayBuffer(buf) }
  })

  ipcMain.handle('file:open-image', async (): Promise<OpenedFile | null> => {
    const win = getWin()
    if (!win) return null
    const _ = (k: string) => t(getLang(), k)
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: _('files.images'), extensions: IMAGE_EXTS }],
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    const buf = await readFile(path)
    return { path, name: basename(path), data: bufToArrayBuffer(buf) }
  })

  ipcMain.handle(
    'file:save-dialog',
    async (_e, kind: 'project' | 'ora' | 'export', defaultName: string): Promise<string | null> => {
      const win = getWin()
      if (!win) return null
      const _ = (k: string) => t(getLang(), k)
      const filters =
        kind === 'project'
          ? [{ name: BRAND.nameLatin, extensions: [BRAND.fileExt.slice(1)] }]
          : kind === 'ora'
            ? [{ name: 'OpenRaster', extensions: ['ora'] }]
            : [
                { name: 'PNG', extensions: ['png'] },
                { name: 'JPEG', extensions: ['jpg'] },
                { name: 'WebP', extensions: ['webp'] },
              ]
      const res = await dialog.showSaveDialog(win, {
        defaultPath: defaultName,
        filters,
        title: _('files.saveTitle'),
      })
      return res.canceled || !res.filePath ? null : res.filePath
    },
  )

  ipcMain.handle('file:write', async (_e, path: string, data: ArrayBuffer): Promise<void> => {
    await writeFile(path, Buffer.from(data))
  })

  ipcMain.handle('file:read', async (_e, path: string): Promise<ArrayBuffer> => {
    return bufToArrayBuffer(await readFile(path))
  })

  // ── Библиотека промтов ──
  const promptsPath = (): string => join(app.getPath('userData'), 'prompts.json')

  ipcMain.handle('prompts:load', async (): Promise<string> => {
    try {
      return (await readFile(promptsPath())).toString('utf8')
    } catch {
      return '[]'
    }
  })

  ipcMain.handle('prompts:save', async (_e, json: string): Promise<void> => {
    JSON.parse(json) // валидация до записи
    await writeFile(promptsPath(), json, 'utf8')
  })

  // ── Автосохранение ──
  const autosavePath = (): string => join(app.getPath('userData'), `recover${BRAND.fileExt}`)

  ipcMain.handle('autosave:check', async (): Promise<boolean> => {
    try {
      await readFile(autosavePath())
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('autosave:write', async (_e, data: ArrayBuffer): Promise<void> => {
    await writeFile(autosavePath(), Buffer.from(data))
  })

  ipcMain.handle('autosave:read', async (): Promise<ArrayBuffer> => {
    return bufToArrayBuffer(await readFile(autosavePath()))
  })

  ipcMain.handle('autosave:clear', async (): Promise<void> => {
    await unlink(autosavePath()).catch(() => undefined)
  })

  // ── Кисти ──
  ipcMain.handle('brushes:pick-files', async (): Promise<OpenedFile[]> => {
    const win = getWin()
    if (!win) return []
    const _ = (k: string) => t(getLang(), k)
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: _('files.brushes'), extensions: ['abr', 'kpp'] }],
    })
    if (res.canceled) return []
    return Promise.all(
      res.filePaths.map(async (path) => ({
        path,
        name: basename(path),
        data: bufToArrayBuffer(await readFile(path)),
      })),
    )
  })

  ipcMain.handle('brushes:list', async (): Promise<{ file: string; json: string }[]> => {
    const dir = brushesDir()
    await mkdir(dir, { recursive: true })
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    return Promise.all(
      files.map(async (file) => ({ file, json: (await readFile(join(dir, file))).toString('utf8') })),
    )
  })

  ipcMain.handle('brushes:save', async (_e, file: string, json: string): Promise<void> => {
    const dir = brushesDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, sanitize(file)), json, 'utf8')
  })

  ipcMain.handle('brushes:delete', async (_e, file: string): Promise<void> => {
    await unlink(join(brushesDir(), sanitize(file)))
  })
}

function sanitize(name: string): string {
  return name.replace(/[/\\]/g, '_')
}

function bufToArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
