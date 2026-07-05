import { editor } from '../controller/EditorController'
import { useAiStore } from '../stores/aiStore'
import { useEditorStore } from '../stores/editorStore'
import {
  DEFAULT_MODELS,
  UPSCALE_MODEL,
  usePolzaStore,
  type PolzaJob,
  type PolzaModel,
  type PromptPreset,
} from '../stores/polzaStore'
import { bytesToBase64, pixelsToPng } from './pixels'
import { useTabsStore } from './tabs'

function setError(e: unknown): void {
  usePolzaStore.getState().set({ error: e instanceof Error ? e.message : String(e), busy: false })
}

export async function refreshPolzaStatus(): Promise<void> {
  const hasKey = await window.slojka.polzaHasKey().catch(() => false)
  usePolzaStore.getState().set({ hasKey })
}

export async function savePolzaKey(): Promise<void> {
  const s = usePolzaStore.getState()
  await window.slojka.polzaSetKey(s.keyInput.trim())
  s.set({ keyInput: '' })
  await refreshPolzaStatus()
}

/**
 * Автовставка результатов: задачи, отправленные или активные в ЭТОЙ сессии.
 * Старые completed из БД очереди при старте не вставляем — они уже были
 * вставлены (или намеренно оставлены) раньше. Задача привязана к вкладке,
 * из которой её отправили: результат не сваливается в чужой документ.
 */
const watchedJobs = new Map<string, string | null>() // jobId → tabId
const autoInserted = new Set<string>()
const notifiedReady = new Set<string>()

/** Пометить задачу для автовставки (вызывается в момент отправки). */
function watchJob(jobId: string): void {
  watchedJobs.set(jobId, useTabsStore.getState().activeId)
}

export async function refreshJobs(): Promise<void> {
  try {
    const { jobs } = await window.slojka.polzaJobs()
    usePolzaStore.getState().set({ jobs })
    await autoInsertFinished(jobs)
  } catch {
    // sidecar не запущен — панель покажет подсказку
  }
}

/**
 * Поллинг задач на уровне приложения: автовставка работает и при
 * свёрнутой панели ИИ (панель лишь дополнительно обновляет статус).
 */
let pollTimer: number | null = null
export function startJobPolling(): void {
  if (pollTimer !== null) return
  pollTimer = window.setInterval(() => {
    if (useAiStore.getState().state === 'ready') void refreshJobs()
  }, 3000)
}

async function autoInsertFinished(jobs: PolzaJob[]): Promise<void> {
  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'processing') {
      if (!watchedJobs.has(job.id)) watchedJobs.set(job.id, useTabsStore.getState().activeId)
      continue
    }
    if (job.status !== 'completed' || !watchedJobs.has(job.id) || autoInserted.has(job.id)) {
      continue
    }
    const tabs = useTabsStore.getState()
    const jobTab = watchedJobs.get(job.id) ?? null
    if (jobTab && !tabs.tabs.some((t) => t.id === jobTab)) {
      // Вкладку закрыли — автоматически не вставляем (кнопка ⤵ остаётся).
      autoInserted.add(job.id)
      continue
    }
    if (jobTab && tabs.activeId !== jobTab) {
      // Результат ждёт свою вкладку; один раз подсказываем об этом.
      if (!notifiedReady.has(job.id)) {
        notifiedReady.add(job.id)
        const name = tabs.tabs.find((t) => t.id === jobTab)?.name ?? ''
        useEditorStore.getState().setToast(`Результат готов — вставится во вкладке «${name}»`)
      }
      continue
    }
    if (!editor.engineForIo.hasDocument) continue
    autoInserted.add(job.id)
    for (let i = 0; i < job.result_files.length; i++) {
      await insertResult(job.id, i)
    }
  }
}

export async function refreshModels(): Promise<void> {
  try {
    const { models } = await window.slojka.polzaModels()
    const live: PolzaModel[] = models
      .filter((m) => m.id)
      .map((m) => ({ id: m.id!, name: m.name || m.id! }))
    if (live.length > 0) {
      // Живой список первичен; известные из документации модели, которых
      // в нём вдруг нет, оставляем в хвосте — их всё равно можно выбрать.
      const liveIds = new Set(live.map((m) => m.id))
      const merged = [...live, ...DEFAULT_MODELS.filter((m) => !liveIds.has(m.id))]
      const s = usePolzaStore.getState()
      s.set({
        models: merged,
        model: merged.some((m) => m.id === s.model) ? s.model : merged[0]!.id,
      })
    }
  } catch (e) {
    setError(e)
  }
}

/**
 * Визуальная разметка области для модели: по границе маски рисуется красный
 * контур на белой подложке (виден на любом фоне и после даунскейла у
 * провайдера). Универсальный media-API polza.ai маску не принимает, поэтому
 * «где именно» модель узнаёт из самой картинки + промта про контур.
 */
function drawSelectionOutline(pixels: Uint8Array, w: number, h: number, mask: Uint8Array): void {
  // Порог низкий (32, не 128): на растушёванном выделении контур обходит
  // всю «мягкую» зону, а не режет её пополам.
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]! > 32
  const boundary: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (
        inside(x, y) &&
        (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1))
      ) {
        boundary.push(y * w + x)
      }
    }
  }
  const rRed = Math.max(2, Math.round(Math.min(w, h) / 300))
  const rWhite = rRed + Math.max(1, Math.round(rRed / 2))
  // Пиксели premultiplied, но непрозрачные цвета совпадают со straight-RGBA.
  const paint = (r: number, cr: number, cg: number, cb: number): void => {
    for (const idx of boundary) {
      const bx = idx % w
      const by = (idx / w) | 0
      for (let dy = -r; dy <= r; dy++) {
        const yy = by + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -r; dx <= r; dx++) {
          const xx = bx + dx
          if (xx < 0 || xx >= w || dx * dx + dy * dy > r * r) continue
          const o = (yy * w + xx) * 4
          pixels[o] = cr
          pixels[o + 1] = cg
          pixels[o + 2] = cb
          pixels[o + 3] = 255
        }
      }
    }
  }
  paint(rWhite, 255, 255, 255)
  paint(rRed, 255, 0, 0)
}

async function compositeBase64(outlineMask?: Uint8Array): Promise<string> {
  const { pixels, width, height } = editor.engineForIo.readComposite()
  if (outlineMask && outlineMask.length === width * height) {
    drawSelectionOutline(pixels, width, height, outlineMask)
  }
  const png = await pixelsToPng(pixels, width, height)
  return bytesToBase64(png)
}

/**
 * Ближайшее к документу соотношение сторон. Только универсальный набор,
 * который принимают ВСЕ модели (gpt-image, например, не знает 3:2/2:3/21:9 —
 * «Модель не поддерживает aspect_ratio»). Небольшое расхождение пропорций
 * компенсируется при вставке результата (cover-заполнение под холст).
 */
function closestAspect(w: number, h: number): string {
  const choices: [string, number][] = [
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
  ]
  const r = w / h
  return choices.reduce((best, c) => (Math.abs(c[1] - r) < Math.abs(best[1] - r) ? c : best))[0]
}

export async function submitGenerate(): Promise<void> {
  const s = usePolzaStore.getState()
  if (!s.prompt.trim()) return
  s.set({ busy: true, error: null })
  try {
    const input: Record<string, unknown> = {
      prompt: s.prompt,
      aspect_ratio: s.aspectRatio,
      max_images: s.maxImages,
    }
    if (s.seed.trim()) input['seed'] = Number(s.seed)
    const job = await window.slojka.polzaGenerate({ kind: 'generate', model: s.model, input })
    watchJob(job.id)
    s.set({ busy: false })
    await refreshJobs()
  } catch (e) {
    setError(e)
  }
}

export async function submitUpscale(factor: '2x' | '4x' | '8x'): Promise<void> {
  const s = usePolzaStore.getState()
  if (!editor.engineForIo.hasDocument) return
  s.set({ busy: true, error: null })
  try {
    const image = await compositeBase64()
    // Апскейл — всегда topaz/image-upscale; фактор — строка без «x» (по докам).
    const job = await window.slojka.polzaGenerate({
      kind: 'upscale',
      model: UPSCALE_MODEL,
      input: {
        prompt: '',
        images: [{ type: 'base64', data: image }],
        upscale_factor: factor.replace('x', ''),
      },
    })
    watchJob(job.id)
    s.set({ busy: false })
    await refreshJobs()
  } catch (e) {
    setError(e)
  }
}

/**
 * Комбо SAM/выделение + генерация: удалить или заменить объект.
 * Модели уходит весь композит, на котором граница выделения обведена
 * красным контуром (media-API маску не принимает — модель видит область
 * прямо на картинке). Результат вставляется НОВЫМ СЛОЕМ всей сценой,
 * растянутым под холст: если модель тронула что-то вне области, рассинхрона
 * со старым фоном не будет.
 */
export async function submitObjectEdit(mode: 'remove' | 'replace'): Promise<void> {
  const s = usePolzaStore.getState()
  const engine = editor.engineForIo
  const sel = engine.readSelectionMask()
  if (!sel.active) {
    s.set({ error: 'Сначала выделите объект (SAM или любым инструментом)' })
    return
  }
  if (mode === 'replace' && !s.prompt.trim()) {
    s.set({ error: 'Опишите в промте, чем заменить объект' })
    return
  }
  s.set({ busy: true, error: null })
  try {
    const docJson = engine.getDocumentJson()!
    const image = await compositeBase64(sel.mask)
    const prompt =
      mode === 'remove'
        ? 'На изображении объект обведён красным контуром. Удали этот объект и правдоподобно восстанови фон за ним. Сам красный контур тоже убери. Всё остальное изображение оставь без изменений, пиксель в пиксель.'
        : `На изображении объект обведён красным контуром. Замени этот объект на: ${s.prompt}. Сам красный контур тоже убери. Всё остальное изображение оставь без изменений, пиксель в пиксель.`
    const job = await window.slojka.polzaGenerate({
      kind: mode,
      model: s.model,
      input: {
        prompt,
        images: [{ type: 'base64', data: image }],
        // Просим формат, максимально близкий к холсту, — меньше искажений
        // при обратной вставке всей сценой.
        aspect_ratio: closestAspect(docJson.width, docJson.height),
      },
    })
    watchJob(job.id)
    s.set({ busy: false })
    await refreshJobs()
  } catch (e) {
    setError(e)
  }
}

/**
 * «Фотобаш»: всё видимое на холсте виртуально сводится в одну картинку и
 * уходит выбранной модели с промтом профессионального photobash/matte
 * painting — модель пересобирает коллаж в цельную сцену (единый свет,
 * камера, материалы). {} в шаблоне — описание сцены из поля промта.
 */
const PHOTOBASH_PROMPT = `PROFESSIONAL PHOTOBASH + MATTE PAINTING

Create a seamless high-end photobash and matte painting. This is NOT a collage, NOT a digital illustration, and NOT simple photo manipulation. The final image must look like a single premium concept-art keyframe created for a Hollywood blockbuster by a senior AAA concept artist.

PRIMARY GOAL

Every imported asset is ONLY a semantic and geometric reference.

Completely discard the original appearance of every source.

Do NOT preserve:
- original lighting
- original shadows
- original highlights
- original color grading
- original exposure
- original white balance
- original atmosphere
- original camera response
- original lens characteristics
- original era
- original photographic style
- original rendering style

Reconstruct every object as if it had been photographed specifically for this scene.

IMAGE RECONSTRUCTION

Treat every element as raw material.

After placing assets, completely rebuild them:
- re-light surfaces
- repaint textures
- recreate reflections
- recreate shadows
- rebuild local colors
- rebuild material response
- refine silhouettes
- reconstruct edges
- recreate microdetails

Never simply blend photos. Reconstruct them into one coherent image.

GLOBAL COHERENCE

Everything must exist in one physical environment with:

- one camera
- one lens
- one focal length
- one perspective
- one depth of field
- one exposure
- one white balance
- one color science
- one HDR response
- one atmospheric perspective
- one lighting setup
- one global illumination solution
- one shadow softness
- one level of detail
- one texture density
- one grain structure
- one sharpness profile

Every object must appear photographed in the same place, at the same moment, with the same camera.

LIGHTING

Ignore lighting from every source image.

Assume every imported asset was photographed incorrectly.

Re-light everything from scratch using only the lighting of the current scene.

All highlights, shadows, reflections, bounce light and ambient light must be regenerated consistently.

MATERIALS

All materials must be physically believable.

Metal behaves like real metal.
Glass like real glass.
Fabric like real fabric.
Stone like real stone.
Concrete like real concrete.
Skin like real skin.

Use realistic:
- micro surface detail
- subtle imperfections
- edge wear
- roughness variation
- fine scratches
- dirt accumulation
- physically plausible reflections

MATTE PAINTING

Create a cinematic environment with:
- layered depth
- atmospheric haze
- realistic scale
- natural perspective
- volumetric lighting
- coherent background integration

The background must feel like part of the same photograph, never a separate plate.

FINAL OVERPAINT

After compositing, perform a full-scene overpaint.

Unify:
- lighting
- materials
- textures
- edges
- color response
- atmosphere
- contrast
- microdetails

The final image must look painted over as a whole, not assembled from separate assets.

QUALITY

Hollywood feature film concept art.
AAA concept art.
Premium cinematic matte painting.
Studio-quality compositing.
Production-ready keyframe.
Ultra-refined finish.
Invisible source integration.
Extreme visual cohesion.
Highest production value.

NEGATIVE CONSTRAINTS

No collage.
No cutout look.
No visible compositing.
No mismatched lighting.
No mismatched color grading.
No mismatched sharpness.
No mismatched perspective.
No floating objects.
No halos.
No masking artifacts.
No duplicated textures.
No inconsistent shadows.
No inconsistent reflections.
No CGI pasted onto photos.
No obvious source boundaries.
No separate visual styles.
No mixed photographic eras.

SCENE:
{}`

export async function submitPhotobash(): Promise<void> {
  const s = usePolzaStore.getState()
  const engine = editor.engineForIo
  if (!engine.hasDocument) return
  s.set({ busy: true, error: null })
  try {
    const docJson = engine.getDocumentJson()!
    const image = await compositeBase64()
    const job = await window.slojka.polzaGenerate({
      kind: 'photobash',
      model: s.model,
      input: {
        prompt: PHOTOBASH_PROMPT.replace('{}', s.prompt.trim()),
        images: [{ type: 'base64', data: image }],
        // Ориентация результата — примерно как у холста.
        aspect_ratio: closestAspect(docJson.width, docJson.height),
      },
    })
    watchJob(job.id)
    s.set({ busy: false })
    await refreshJobs()
  } catch (e) {
    setError(e)
  }
}

export async function cancelJob(id: string): Promise<void> {
  await window.slojka.polzaCancel(id).catch(setError)
  await refreshJobs()
}

/** Убрать одну задачу из списка (завершённую или зависшую). */
export async function removeJob(id: string): Promise<void> {
  await window.slojka.polzaRemove(id).catch(setError)
  await refreshJobs()
}

/** Очистить все завершённые задачи (completed/failed/cancelled/timeout). */
export async function clearFinishedJobs(): Promise<void> {
  await window.slojka.polzaClearFinished().catch(setError)
  await refreshJobs()
}

/**
 * Вставить результат задачи новым слоем. Для удаления/замены объекта —
 * вся сцена, растянутая ровно под холст (модель могла отдать другое
 * разрешение): старые слои остаются под ней нетронутыми.
 */
export async function insertResult(jobId: string, index: number): Promise<void> {
  try {
    const { png_base64 } = await window.slojka.polzaResult(jobId, index)
    const bytes = Uint8Array.from(atob(png_base64), (c) => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]))
    const engine = editor.engineForIo
    const job = usePolzaStore.getState().jobs.find((j) => j.id === jobId)
    // Выделение своё дело сделало (разметка области) — муравьи больше не нужны.
    if (engine.hasSelection) engine.deselect()
    const layerId = engine.addImageLayer(bmp, `polza ${index + 1}`)

    const doc = engine.getDocumentJson()
    let toast = 'Результат вставлен новым слоем'
    if (doc && (job?.kind === 'remove' || job?.kind === 'replace' || job?.kind === 'photobash')) {
      const arDoc = doc.width / doc.height
      const arImg = bmp.width / bmp.height
      let sx = doc.width / bmp.width
      let sy = doc.height / bmp.height
      if (Math.abs(arImg - arDoc) / arDoc > 0.02) {
        // Пропорции разошлись: не искажаем картинку, а равномерно накрываем
        // холст (края подрежутся) — и честно предупреждаем.
        sx = sy = Math.max(sx, sy)
        toast = 'Модель вернула другие пропорции — вставлено без искажений, с подрезкой краёв'
      }
      engine.setSmartTransform(
        layerId,
        { cx: doc.width / 2, cy: doc.height / 2, dx: 0, dy: 0, sx, sy, rot: 0 },
        { history: false },
      )
    }
    useEditorStore.getState().setToast(toast)
  } catch (e) {
    setError(e)
  }
}

// ── Библиотека промтов ──

export async function loadPrompts(): Promise<void> {
  try {
    const json = await window.slojka.promptsLoad()
    const prompts = JSON.parse(json) as PromptPreset[]
    usePolzaStore.getState().set({ prompts: Array.isArray(prompts) ? prompts : [] })
  } catch {
    usePolzaStore.getState().set({ prompts: [] })
  }
}

export async function savePrompts(prompts: PromptPreset[]): Promise<void> {
  usePolzaStore.getState().set({ prompts })
  await window.slojka.promptsSave(JSON.stringify(prompts, null, 1))
}
