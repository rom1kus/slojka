#!/usr/bin/env node
/**
 * Скачивает официальные установщики системных пререквизитов Windows для
 * вшивания в NSIS-инсталлер (см. packages/app/build/installer.nsh):
 * - Microsoft Visual C++ Redistributable x64 — без него не импортируется
 *   PyTorch (OSError WinError 126 на fbgemm.dll);
 * - Python 3.11.9 — для функций локального ИИ.
 * Результат: packages/app/build/win-prereqs/ (в .gitignore). Повторный
 * запуск ничего не качает, если файлы уже на месте и похожи на правду.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const dst = join(dirname(fileURLToPath(import.meta.url)), '../packages/app/build/win-prereqs')
mkdirSync(dst, { recursive: true })

const ITEMS = [
  {
    name: 'vc_redist.x64.exe',
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    minBytes: 10_000_000,
  },
  {
    name: 'python-3.11.9-amd64.exe',
    url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe',
    minBytes: 20_000_000,
  },
]

const looksValid = (path, minBytes) => {
  try {
    if (statSync(path).size < minBytes) return false
    // Подписанные PE-файлы начинаются с MZ.
    const head = readFileSync(path).subarray(0, 2).toString('ascii')
    return head === 'MZ'
  } catch {
    return false
  }
}

for (const item of ITEMS) {
  const path = join(dst, item.name)
  if (looksValid(path, item.minBytes)) {
    console.log(`[prereqs] уже есть: ${item.name}`)
    continue
  }
  console.log(`[prereqs] скачивание ${item.url}`)
  const res = await fetch(item.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${item.name}: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path))
  if (!looksValid(path, item.minBytes)) {
    throw new Error(`${item.name}: скачанный файл не похож на установщик`)
  }
  console.log(`[prereqs] готово: ${item.name}, ${Math.round(statSync(path).size / 1e6)} МБ`)
}
console.log(`[prereqs] всё на месте → ${dst}`)
