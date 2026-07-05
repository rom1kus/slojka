#!/usr/bin/env node
/**
 * Slojka MCP-сервер (stdio ↔ WS-мост).
 *
 * Его запускает Claude Code (через .mcp.json). Подключается к работающему
 * приложению Слойка по WebSocket: адрес и токен — в mcp-bridge.json,
 * который приложение пишет при старте. Если приложение не запущено,
 * каждый инструмент возвращает понятную ошибку.
 *
 * Плоский JavaScript без сборки — файл исполняется напрямую.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const BRAND_ID = 'slojka'

function bridgeFilePath() {
  // Должен совпадать с app.getPath('appData') Electron на каждой платформе.
  let appData
  if (process.platform === 'win32') {
    appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    appData = join(homedir(), 'Library', 'Application Support')
  } else {
    appData = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  }
  return join(appData, BRAND_ID, 'mcp-bridge.json')
}

/** Подключение к мосту (переподключается при каждом обрыве). */
let ws = null
let wsReady = null
const pending = new Map()
let seq = 0

async function connect() {
  const raw = await readFile(bridgeFilePath(), 'utf8').catch(() => null)
  if (!raw) {
    throw new Error('Слойка не запущена: откройте приложение и повторите.')
  }
  const { port, token } = JSON.parse(raw)

  ws = new WebSocket(`ws://127.0.0.1:${port}`)
  wsReady = new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ token }))
    })
    ws.once('message', () => resolve()) // ответ авторизации
    ws.once('error', (e) => reject(new Error(`Слойка недоступна: ${e.message}`)))
    ws.once('close', () => reject(new Error('Слойка закрыла соединение')))
  })
  await wsReady

  ws.on('message', (raw2) => {
    let msg
    try {
      msg = JSON.parse(raw2.toString())
    } catch {
      return
    }
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id)
    if (msg.error) call.reject(new Error(msg.error))
    else call.resolve(msg.result)
  })
  ws.on('close', () => {
    ws = null
    for (const call of pending.values()) call.reject(new Error('Соединение со Слойкой потеряно'))
    pending.clear()
  })
}

async function call(tool, args) {
  if (!ws || ws.readyState !== WebSocket.OPEN) await connect()
  const id = `${++seq}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, tool, args }))
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`таймаут инструмента ${tool}`))
    }, 120000)
  })
}

const server = new McpServer({ name: 'slojka', version: '0.1.0' })

/** Обёртка: результат JSON-текстом; {__image} — картинкой. */
function tool(name, description, shape, handler = null) {
  server.tool(name, description, shape, async (args) => {
    const result = await (handler ? handler(args) : call(name, args))
    if (result && typeof result === 'object' && result.__image) {
      return {
        content: [{ type: 'image', data: result.__image, mimeType: 'image/png' }],
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] }
  })
}

// ── Документ и файлы ──
tool('get_document_info', 'Информация о документе: размер, слои, выделение', {})
tool('new_document', 'Создать новый холст', {
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  background: z.enum(['white', 'transparent']).default('white'),
})
tool('open_project', 'Открыть файл (.slojka/.ora/.psd/png/jpg/webp) по абсолютному пути', {
  path: z.string(),
})
tool('save_project', 'Сохранить проект в .slojka (path обязателен для нового файла)', {
  path: z.string().optional(),
})
tool('export_image', 'Экспортировать композит в PNG/JPEG/WebP по указанному пути', {
  path: z.string(),
})
tool(
  'get_canvas_png',
  'Текущий вид документа (композит) как PNG-картинка. scale уменьшает (0.1–1)',
  { scale: z.number().min(0.05).max(1).default(0.5) },
)

// ── Слои ──
tool('list_layers', 'Список слоёв (снизу вверх) с id и свойствами', {})
tool('create_layer', 'Создать пустой растровый слой над активным', { name: z.string() })
tool('delete_layer', 'Удалить слой по id', { id: z.string() })
tool('set_active_layer', 'Сделать слой активным', { id: z.string() })
tool(
  'set_layer_props',
  'Изменить свойства слоя: имя/видимость/непрозрачность/режим/clipping',
  {
    id: z.string(),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    blendMode: z
      .enum(['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'darken', 'lighten', 'add'])
      .optional(),
    clipped: z.boolean().optional(),
  },
)
tool('add_text_layer', 'Добавить текстовый слой', {
  content: z.string(),
  x: z.number(),
  y: z.number(),
  fontSize: z.number().default(48),
  color: z.string().default('#1e1e1e'),
  fontFamily: z.string().default('sans-serif'),
})
tool('flatten_image', 'Свести все слои в один', {})

// ── Выделение ──
tool('select_rect', 'Прямоугольное выделение (координаты документа)', {
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  op: z.enum(['replace', 'add', 'subtract', 'intersect']).default('replace'),
})
tool('select_all', 'Выделить всё', {})
tool('deselect', 'Снять выделение', {})
tool('invert_selection', 'Инвертировать выделение', {})
tool('feather_selection', 'Растушевать выделение (px)', { radius: z.number().min(1).max(100) })
tool(
  'sam_select',
  'AI-выделение объекта через SAM 2.1 по точкам (label 1 — объект, 0 — исключить). Требует включённого SAM в настройках.',
  {
    points: z.array(z.object({ x: z.number(), y: z.number(), label: z.number().min(0).max(1) })),
  },
)

// ── Рисование ──
tool('fill_selection', 'Залить выделение (или весь слой) цветом на активном слое', {
  color: z.string().describe('#rrggbb'),
})
tool('clear_selection_area', 'Очистить содержимое выделения на активном слое', {})
tool(
  'brush_stroke',
  'Провести мазок кистью по точкам (координаты документа) на активном слое',
  {
    points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
    color: z.string().default('#1e1e1e'),
    size: z.number().min(1).max(500).default(24),
    hardness: z.number().min(0).max(1).default(0.8),
    opacity: z.number().min(0).max(1).default(1),
    erase: z.boolean().default(false),
  },
)

// ── История ──
tool('undo', 'Отменить последнее действие', {})
tool('redo', 'Повторить отменённое действие', {})

// ── Генерация (polza.ai) ──
tool(
  'polza_generate',
  'Запустить генерацию изображения через polza.ai (нужен ключ в настройках). Возвращает id задачи; статус смотреть polza_job_status.',
  {
    model: z.string().describe('id модели, например nano-banana'),
    prompt: z.string(),
    aspect_ratio: z.string().default('1:1'),
    max_images: z.number().int().min(1).max(4).default(1),
  },
)
tool('polza_job_status', 'Статус задачи генерации по id', { id: z.string() })
tool(
  'polza_insert_result',
  'Вставить результат завершённой задачи в документ новым слоем',
  { id: z.string(), index: z.number().int().min(0).default(0) },
)

const transport = new StdioServerTransport()
void server.connect(transport)
