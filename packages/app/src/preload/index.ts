import { contextBridge, ipcRenderer } from 'electron'
import type { Lang } from '@slojka/shared'

export interface PolzaJob {
  id: string
  polza_id: string | null
  kind: string
  model: string
  request_json: string
  status: string
  error: string | null
  cost_rub: number | null
  result_files: string[]
  created_at: number
  updated_at: number
}

const api = {
  getLanguage: (): Promise<Lang> => ipcRenderer.invoke('settings:get-language'),
  setLanguage: (lang: Lang): Promise<void> => ipcRenderer.invoke('settings:set-language', lang),
  getAppInfo: (): Promise<{ name: string; version: string; electron: string; chrome: string }> =>
    ipcRenderer.invoke('app:info'),
  getFonts: (): Promise<string[]> => ipcRenderer.invoke('fonts:list'),

  windowMinimize: (): void => ipcRenderer.send('window:minimize'),
  windowMaximize: (): void => ipcRenderer.send('window:maximize'),
  windowClose: (): void => ipcRenderer.send('window:close'),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),

  openDocumentDialog: (): Promise<{ path: string; name: string; data: ArrayBuffer } | null> =>
    ipcRenderer.invoke('file:open-document'),
  openImageDialog: (): Promise<{ path: string; name: string; data: ArrayBuffer } | null> =>
    ipcRenderer.invoke('file:open-image'),
  saveDialog: (kind: 'project' | 'ora' | 'export', defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('file:save-dialog', kind, defaultName),
  writeFile: (path: string, data: ArrayBuffer): Promise<void> =>
    ipcRenderer.invoke('file:write', path, data),
  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('file:read', path),

  getSetting: (key: string): Promise<unknown> => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('settings:set', key, value),

  // ── Локальный ИИ ──
  aiStatus: (): Promise<{
    python: string | null
    baseInstalled: boolean
    state: 'absent' | 'starting' | 'ready' | 'error'
    sam: { installed: boolean; loaded: boolean; model_size: string | null; device: string | null } | null
    checkpoints: string[]
  }> => ipcRenderer.invoke('ai:status'),
  aiEnable: (): Promise<void> => ipcRenderer.invoke('ai:enable'),
  aiDisable: (): Promise<void> => ipcRenderer.invoke('ai:disable'),
  aiInstallSam: (size: string): Promise<void> => ipcRenderer.invoke('ai:install-sam', size),
  aiSamLoad: (size: string): Promise<void> => ipcRenderer.invoke('ai:sam-load', size),
  aiSamSetImage: (pngBase64: string): Promise<{ cached: boolean }> =>
    ipcRenderer.invoke('ai:sam-set-image', pngBase64),
  aiSamPredict: (req: {
    points: { x: number; y: number; label: number }[]
    box?: number[]
  }): Promise<{ masks: { score: number; png_base64: string }[] }> =>
    ipcRenderer.invoke('ai:sam-predict', req),
  aiDeleteData: (): Promise<void> => ipcRenderer.invoke('ai:delete-data'),
  onAiProgress: (cb: (p: { stage: string; message: string; pct?: number }) => void): void => {
    ipcRenderer.on('ai:progress', (_e, p) => cb(p))
  },
  onAiState: (cb: (state: string) => void): void => {
    ipcRenderer.on('ai:state', (_e, s: string) => cb(s))
  },

  // ── MCP ──
  onMcpCall: (cb: (id: string, tool: string, args: unknown) => void): void => {
    ipcRenderer.on('mcp:call', (_e, id: string, tool: string, args: unknown) =>
      cb(id, tool, args),
    )
  },
  mcpResult: (id: string, result: unknown, error: string | null): void => {
    ipcRenderer.send('mcp:result', id, result, error)
  },

  // ── Терминал ──
  termAvailable: (): Promise<{ ok: boolean; error: string | null }> =>
    ipcRenderer.invoke('term:available'),
  termStart: (opts: {
    filePath: string | null
    cols: number
    rows: number
  }): Promise<{ id: number; cwd: string }> => ipcRenderer.invoke('term:start', opts),
  termInput: (id: number, data: string): void => {
    ipcRenderer.send('term:input', id, data)
  },
  termResize: (id: number, cols: number, rows: number): void => {
    ipcRenderer.send('term:resize', id, cols, rows)
  },
  termKill: (id: number): void => {
    ipcRenderer.send('term:kill', id)
  },
  onTermData: (cb: (id: number, data: string) => void): void => {
    ipcRenderer.on('term:data', (_e, id: number, data: string) => cb(id, data))
  },
  onTermExit: (cb: (id: number, code: number) => void): void => {
    ipcRenderer.on('term:exit', (_e, id: number, code: number) => cb(id, code))
  },

  // ── Polza ──
  polzaSetKey: (key: string): Promise<void> => ipcRenderer.invoke('polza:set-key', key),
  polzaHasKey: (): Promise<boolean> => ipcRenderer.invoke('polza:has-key'),
  polzaGenerate: (req: {
    kind: string
    model: string
    input: Record<string, unknown>
  }): Promise<PolzaJob> => ipcRenderer.invoke('polza:generate', req),
  polzaJobs: (): Promise<{ jobs: PolzaJob[] }> => ipcRenderer.invoke('polza:jobs'),
  polzaCancel: (id: string): Promise<void> => ipcRenderer.invoke('polza:cancel', id),
  polzaRemove: (id: string): Promise<void> => ipcRenderer.invoke('polza:remove', id),
  polzaClearFinished: (): Promise<{ removed: number }> =>
    ipcRenderer.invoke('polza:clear-finished'),
  polzaResult: (id: string, index: number): Promise<{ filename: string; png_base64: string }> =>
    ipcRenderer.invoke('polza:result', id, index),
  polzaModels: (): Promise<{ models: { id?: string; name?: string }[] }> =>
    ipcRenderer.invoke('polza:models'),

  // ── Библиотека промтов ──
  promptsLoad: (): Promise<string> => ipcRenderer.invoke('prompts:load'),
  promptsSave: (json: string): Promise<void> => ipcRenderer.invoke('prompts:save', json),

  autosaveCheck: (): Promise<boolean> => ipcRenderer.invoke('autosave:check'),
  autosaveWrite: (data: ArrayBuffer): Promise<void> => ipcRenderer.invoke('autosave:write', data),
  autosaveRead: (): Promise<ArrayBuffer> => ipcRenderer.invoke('autosave:read'),
  autosaveClear: (): Promise<void> => ipcRenderer.invoke('autosave:clear'),

  pickBrushFiles: (): Promise<{ path: string; name: string; data: ArrayBuffer }[]> =>
    ipcRenderer.invoke('brushes:pick-files'),
  listBrushes: (): Promise<{ file: string; json: string }[]> => ipcRenderer.invoke('brushes:list'),
  saveBrush: (file: string, json: string): Promise<void> =>
    ipcRenderer.invoke('brushes:save', file, json),
  deleteBrush: (file: string): Promise<void> => ipcRenderer.invoke('brushes:delete', file),
  onMenuAction: (cb: (id: string) => void): void => {
    ipcRenderer.on('menu:action', (_e, id: string) => cb(id))
  },
  smokeReport: (info: unknown): void => {
    ipcRenderer.send('smoke:report', info)
  },
  isSmoke: process.argv.includes('--slojka-smoke'),
}

export type SlojkaApi = typeof api

contextBridge.exposeInMainWorld('slojka', api)
