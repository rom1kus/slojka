#!/usr/bin/env node
/**
 * Готовит урезанный набор данных @imgly/background-removal-data для упаковки
 * в дистрибутив («Удалить фон»): модель medium + базовые wasm-сборки ort.
 * Варианты jsep (WebGPU) и training не нужны — приложение их не запрашивает,
 * как и модель small. Полный пакет 212 МБ, урезанный ~128 МБ.
 *
 * Результат: packages/app/build/imgly/ (в .gitignore; в сборке — resources/imgly).
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules/@imgly/background-removal-data/dist')
const dst = join(root, 'packages/app/build/imgly')

const KEEP = [
  '/models/medium',
  '/onnxruntime-web/ort-wasm.wasm',
  '/onnxruntime-web/ort-wasm-threaded.wasm',
  '/onnxruntime-web/ort-wasm-simd.wasm',
  '/onnxruntime-web/ort-wasm-simd-threaded.wasm',
]

const all = JSON.parse(readFileSync(join(src, 'resources.json'), 'utf8'))
const kept = {}
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
let bytes = 0
for (const key of KEEP) {
  const entry = all[key]
  if (!entry) throw new Error(`resources.json: нет ключа ${key}`)
  kept[key] = entry
  for (const chunk of entry.chunks) {
    cpSync(join(src, chunk.hash), join(dst, chunk.hash))
    bytes += chunk.offsets[1] - chunk.offsets[0]
  }
}
writeFileSync(join(dst, 'resources.json'), JSON.stringify(kept))
console.log(
  `[imgly] подготовлено ресурсов: ${Object.keys(kept).length}, ~${Math.round(bytes / 1024 / 1024)} МБ → ${dst}`,
)
