import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@slojka/shared'
import { runEngineSelfTest } from '@slojka/engine'
import { collectGlInfo } from './glinfo'
import { switchLanguage } from './i18n'
import { editor } from './controller/EditorController'
import { useEditorStore } from './stores/editorStore'
import { CanvasView } from './components/CanvasView'
import { Toolbar } from './components/Toolbar'
import { ToolOptions } from './components/ToolOptions'
import { LayersPanel } from './components/LayersPanel'
import { NewDocDialog } from './components/NewDocDialog'
import { FeatherDialog } from './components/FeatherDialog'
import { CanvasSizeDialog } from './components/CanvasSizeDialog'
import {
  checkRecovery,
  discardAutosave,
  exportDocument,
  importImageFile,
  openDocument,
  recoverAutosave,
  saveDocument,
  startAutosave,
} from './io/fileOps'
import { loadPresetLibrary } from './io/brushes'
import { startJobPolling } from './io/polzaOps'
import { SettingsDialog } from './components/SettingsDialog'
import { refreshAiStatus, useAiStore, type AiState } from './stores/aiStore'
import { samCommit, samReset, samSessionActive } from './tools/samTool'
import { applyCrop, cancelCrop } from './tools/cropTool'
import { registerMcpExecutor } from './mcp/executor'
import { TerminalPanel } from './components/TerminalPanel'
import { TitleBar } from './components/TitleBar'
import { TabBar } from './components/TabBar'
import { loadSlojka, saveSlojka } from './io/slojkaFormat'
import { Engine } from '@slojka/engine'

/** Round-trip .slojka: сохранить текущий документ → загрузить во второй движок → сравнить композиты. */
async function testSlojkaRoundTrip(): Promise<{ pass: boolean; detail: string }> {
  try {
    const src = editor.engineForIo
    const zip = await saveSlojka(src)
    const tmp = new Engine(new OffscreenCanvas(8, 8))
    await loadSlojka(zip, tmp)
    const a = src.readComposite()
    const b = tmp.readComposite()
    tmp.dispose()
    if (a.width !== b.width || a.height !== b.height) {
      return { pass: false, detail: 'размеры не совпали' }
    }
    let bad = 0
    for (let i = 0; i < a.pixels.length; i++) {
      if (Math.abs(a.pixels[i]! - b.pixels[i]!) > 3) bad++
    }
    const pass = bad < a.pixels.length * 0.001
    return { pass, detail: `zip=${zip.length}b, расхождений=${bad}` }
  } catch (e) {
    return { pass: false, detail: String(e) }
  }
}

/** Координаты пикселя под курсором (справа внизу, как в Photoshop). */
function CursorCoords(): React.JSX.Element | null {
  const pos = useEditorStore((s) => s.cursorPos)
  if (!pos) return null
  return (
    <span className="cursor-coords" title="X, Y">
      ⌖ {pos.x}, {pos.y}
    </span>
  )
}

export function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const glRenderer = useEditorStore((s) => s.glRenderer)
  const glSoftware = useEditorStore((s) => s.glSoftware)
  const zoom = useEditorStore((s) => s.zoom)
  const bgRemovalLayerId = useEditorStore((s) => s.bgRemovalLayerId)
  const hasDoc = useEditorStore((s) => s.docJson !== null)
  const setNewDocOpen = useEditorStore((s) => s.setNewDocOpen)
  const setTool = useEditorStore((s) => s.setTool)
  const tool = useEditorStore((s) => s.tool)

  // Уход с инструмента кадрирования убирает рамку.
  useEffect(() => {
    if (tool !== 'crop') useEditorStore.getState().setCropRect(null)
  }, [tool])
  const fileName = useEditorStore((s) => s.fileName)
  const dirty = useEditorStore((s) => s.dirty)
  const toastMsg = useEditorStore((s) => s.toast)

  // Заголовок окна: имя файла + маркер несохранённых изменений.
  useEffect(() => {
    const base = fileName ?? t('app.untitled')
    document.title = hasDoc ? `${dirty ? '• ' : ''}${base} — Слойка` : 'Слойка'
  }, [fileName, dirty, hasDoc, t])

  // Тост скрывается сам.
  useEffect(() => {
    if (!toastMsg) return
    const id = setTimeout(() => useEditorStore.getState().setToast(null), 4000)
    return () => clearTimeout(id)
  }, [toastMsg])

  // Библиотека кистей (после монтирования канваса — нужен движок).
  useEffect(() => {
    void loadPresetLibrary().then((presets) => useEditorStore.getState().setPresets(presets))
  }, [])

  // MCP: инструменты Claude Code исполняются здесь.
  const [terminalOpen, setTerminalOpen] = useState(false)
  useEffect(() => {
    registerMcpExecutor()
  }, [])

  // Статус локального ИИ + подписка на прогресс установки.
  useEffect(() => {
    void refreshAiStatus()
    window.slojka.onAiProgress((p) => useAiStore.getState().setProgress(p))
    window.slojka.onAiState((s) => {
      useAiStore.getState().setState(s as AiState)
      void refreshAiStatus()
    })
    // Поллинг задач polza живёт на уровне приложения: автовставка
    // результатов работает и при свёрнутой панели ИИ.
    startJobPolling()
  }, [])

  // Автосохранение + предложение восстановления.
  const [recoverOpen, setRecoverOpen] = useState(false)
  useEffect(() => {
    startAutosave()
    if (!window.slojka.isSmoke) {
      void checkRecovery().then((exists) => exists && setRecoverOpen(true))
    }
  }, [])

  // Пункты меню: приходят и из скрытого нативного меню (хоткеи),
  // и из кастомного титлбара — обработчик общий.
  const handleMenuAction = (id: string): void => {
    switch (id) {
        case 'file.new':
          setNewDocOpen(true)
          break
        case 'file.open':
          void openDocument()
          break
        case 'file.import':
          void importImageFile()
          break
        case 'file.save':
          void saveDocument(false)
          break
        case 'file.saveAs':
          void saveDocument(true)
          break
        case 'file.export':
          void exportDocument()
          break
        case 'edit.undo':
          editor.undo()
          break
        case 'edit.redo':
          editor.redo()
          break
        case 'edit.clear':
          editor.clearSelectedArea()
          break
        case 'layer.flatten':
          editor.flattenImage()
          break
        case 'select.all':
          editor.selectAll()
          break
        case 'select.deselect':
          editor.deselect()
          break
        case 'select.invert':
          editor.invertSelection()
          break
        case 'select.feather':
          useEditorStore.getState().setFeatherOpen(true)
          break
        case 'image.canvasSize':
          if (useEditorStore.getState().docJson) useEditorStore.getState().setCanvasSizeOpen(true)
          break
        case 'view.zoomIn':
          editor.zoomStep(1.25)
          break
        case 'view.zoomOut':
          editor.zoomStep(1 / 1.25)
          break
        case 'view.zoomFit':
          editor.zoomFit()
          break
        case 'view.zoomActual':
          editor.zoomActual()
          break
        default:
          console.log(`[menu] ${id} — будет в следующих фазах`)
      }
  }

  useEffect(() => {
    window.slojka.onMenuAction(handleMenuAction)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Горячие клавиши инструментов и размера кисти.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // В полях ввода никакие хоткеи редактора не работают.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const { brush, setBrush } = useEditorStore.getState()

      // ВАЖНО: физические коды клавиш (e.code), а не e.key — иначе в русской
      // раскладке Ctrl+C даёт «с» и ни один буквенный хоткей не срабатывает.
      const code = e.code
      const ctrl = e.ctrlKey || e.metaKey

      if (ctrl) {
        switch (code) {
          case 'KeyA': {
            e.preventDefault()
            // Выделение по фактическим пикселям активного слоя
            // (пустой слой → весь холст).
            const activeId = useEditorStore.getState().docJson?.activeLayerId
            if (activeId) editor.selectFromLayerAlpha(activeId)
            else editor.selectAll()
            return
          }
          case 'KeyD':
            if (!e.shiftKey) {
              e.preventDefault()
              editor.deselect()
            }
            return
          case 'KeyI':
            if (e.shiftKey) {
              e.preventDefault()
              editor.invertSelection()
            }
            return
          case 'KeyZ':
            e.preventDefault()
            if (e.shiftKey) editor.redo()
            else editor.undo()
            return
          case 'KeyY':
            e.preventDefault()
            editor.redo()
            return
          case 'KeyN':
            if (!e.shiftKey) {
              e.preventDefault()
              setNewDocOpen(true)
            }
            return
          case 'KeyO':
            e.preventDefault()
            void openDocument()
            return
          case 'KeyS':
            e.preventDefault()
            if (e.altKey) void exportDocument()
            else void saveDocument(e.shiftKey)
            return
          case 'Equal':
          case 'NumpadAdd':
            e.preventDefault()
            editor.zoomStep(1.25)
            return
          case 'Minus':
          case 'NumpadSubtract':
            e.preventDefault()
            editor.zoomStep(1 / 1.25)
            return
          case 'Digit0':
            e.preventDefault()
            editor.zoomFit()
            return
          case 'Digit1':
            e.preventDefault()
            editor.zoomActual()
            return
          case 'KeyT':
            e.preventDefault()
            if (!editor.floatingState && editor.liftSelection()) setTool('move')
            return
          case 'KeyJ':
            e.preventDefault()
            editor.copySelectionToLayer()
            return
          case 'KeyC':
            e.preventDefault()
            if (editor.copySelection()) useEditorStore.getState().setToast(t('clipboard.copied'))
            return
          case 'KeyX':
            e.preventDefault()
            if (editor.cutSelection()) useEditorStore.getState().setToast(t('clipboard.cut'))
            return
          case 'KeyV':
            e.preventDefault()
            if (editor.pasteAsLayer()) useEditorStore.getState().setToast(t('clipboard.pasted'))
            return
          case 'KeyE': {
            e.preventDefault()
            if (e.shiftKey) {
              editor.flattenImage()
            } else {
              const selected = useEditorStore.getState().selectedLayerIds
              if (selected.length >= 2) editor.mergeLayers(selected)
              else editor.mergeDown()
            }
            return
          }
        }
        return // прочие ctrl-комбинации не наши
      }

      if (e.key === 'Delete') {
        // При активной трансформации Delete удаляет сам фрагмент.
        if (editor.floatingState) editor.deleteFloating()
        else editor.clearSelectedArea()
        return
      }
      // Кадрирование: Enter — применить рамку, Esc — убрать.
      {
        const s = useEditorStore.getState()
        if (s.tool === 'crop' && s.cropRect) {
          if (e.key === 'Enter') {
            applyCrop()
            return
          }
          if (e.key === 'Escape') {
            cancelCrop()
            return
          }
        }
      }
      // Floating-трансформация: Enter — применить, Esc — отменить.
      if (editor.floatingState) {
        if (e.key === 'Enter') {
          editor.commitFloating()
          return
        }
        if (e.key === 'Escape') {
          editor.cancelFloating()
          return
        }
      }
      // Сессия AI-выделения: Enter — принять, Esc — отменить.
      if (samSessionActive()) {
        if (e.key === 'Enter') {
          void samCommit('selection')
          return
        }
        if (e.key === 'Escape') {
          samReset()
          return
        }
      }
      if (e.altKey) return
      switch (code) {
        case 'KeyB':
          setTool('brush')
          break
        case 'KeyE':
          setTool('eraser')
          break
        case 'KeyH':
          setTool('pan')
          break
        case 'KeyV':
          setTool('move')
          break
        case 'KeyM':
          setTool(e.shiftKey ? 'select-ellipse' : 'select-rect')
          break
        case 'KeyL':
          setTool('lasso')
          break
        case 'KeyW':
          setTool('wand')
          break
        case 'KeyT':
          setTool('text')
          break
        case 'KeyC':
          setTool('crop')
          break
        case 'KeyA':
          setTool('sam')
          break
        case 'BracketLeft':
          setBrush({ size: Math.max(1, Math.round(brush.size / 1.15)) })
          break
        case 'BracketRight':
          setBrush({ size: Math.min(500, Math.round(brush.size * 1.15)) })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setTool])

  // Смоук-отчёт: WebGL-инфо + самотест движка + round-trip формата .slojka.
  // В смоук-режиме перед отчётом создаём документ и рисуем штрих —
  // скриншот окна тогда проверяет весь UI-путь.
  useEffect(() => {
    void (async () => {
      let slojkaRoundTrip: unknown = 'skipped'
      if (window.slojka.isSmoke && editor.attached) {
        editor.newDocument(800, 600, 'white')
        useEditorStore.getState().setColor('#c03030')
        editor.beginStroke('brush', 200, 200, 0.8)
        for (let i = 0; i <= 40; i++) {
          editor.strokeTo(200 + i * 8, 200 + Math.sin(i / 4) * 60, 0.8)
        }
        editor.endStroke()
        editor.addLayer('Слой 2')
        const textId = editor.addTextLayerAt(320, 500)
        if (textId) {
          editor.setTextParams(textId, { content: 'Слойка!', fontSize: 64, color: '#2266cc' })
          editor.setLayerStyles(textId, {
            dropShadow: {
              enabled: true,
              color: '#000000',
              opacity: 0.6,
              distance: 6,
              angle: 45,
              size: 8,
            },
          })
        }
        editor.selectRectCss(120, 420, 420, 640)
        slojkaRoundTrip = await testSlojkaRoundTrip()
      }
      // Smart-слой: импорт большой картинки, трансформация без потерь.
      let smartTest: unknown = 'skipped'
      if (window.slojka.isSmoke && editor.attached) {
        try {
          const engine = editor.engineForIo
          engine.newDocument(400, 300, 'transparent')
          const big = new OffscreenCanvas(800, 600)
          const bctx = big.getContext('2d')!
          bctx.fillStyle = '#cc2222'
          bctx.fillRect(0, 0, 800, 600)
          const bmp = await createImageBitmap(big)
          const id = engine.addImageLayer(bmp, 'big', 'bottom')
          const center1 = engine.readComposite().pixels
          const iCenter = (150 * 400 + 200) * 4
          const redAtCenter = center1[iCenter]! > 180 && center1[iCenter + 1]! < 90
          // Уводим картинку далеко и возвращаем — пиксели не должны деградировать.
          engine.setSmartTransform(id!, { dx: 5000 }, { history: false })
          const gone = engine.readComposite().pixels[iCenter]! > 180 &&
            engine.readComposite().pixels[iCenter + 1]! < 90
          engine.setSmartTransform(id!, { dx: 0, sx: 1, sy: 1 }, { history: false })
          const back = engine.readComposite().pixels[iCenter]! > 180
          smartTest = { redAtCenter, movedAway: !gone, back, pass: redAtCenter && !gone && back }
        } catch (e) {
          smartTest = { pass: false, error: String(e) }
        }
      }
      // Ctrl+C/V настоящими keydown-событиями — проверяем сам обработчик.
      let clipboardHotkeys: unknown = 'skipped'
      if (window.slojka.isSmoke && editor.attached) {
        const engine = editor.engineForIo
        const docBefore = engine.getDocumentJson()
        const before = docBefore?.layers.length ?? 0
        // Стили активного слоя должны переехать во вставленный слой.
        if (docBefore?.activeLayerId) {
          engine.setLayerStyles(
            docBefore.activeLayerId,
            { gaussianBlur: { enabled: true, radius: 4 } },
            { history: false },
          )
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true }))
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', ctrlKey: true }))
        const docAfter = engine.getDocumentJson()
        const after = docAfter?.layers.length ?? 0
        const pasted = docAfter?.layers.find((l) => l.id === docAfter.activeLayerId)
        const stylesKept = pasted?.styles?.gaussianBlur?.enabled === true
        clipboardHotkeys = { before, after, stylesKept, pass: after === before + 1 && stylesKept }
      }
      // Удаление фона сквозь весь стек (протокол → wasm → модель → слой):
      // долгий этап, включается переменной SLOJKA_SMOKE_REMOVEBG=1.
      let removeBgTest: unknown = 'skipped'
      if (window.slojka.isSmoke && window.slojka.isSmokeRemoveBg && editor.attached) {
        try {
          const engine = editor.engineForIo
          engine.newDocument(256, 256, 'transparent')
          // Синтетика: яркий круг в центре на светлом фоне.
          const cnv = new OffscreenCanvas(256, 256)
          const cctx = cnv.getContext('2d')!
          cctx.fillStyle = '#e8e8e8'
          cctx.fillRect(0, 0, 256, 256)
          cctx.fillStyle = '#c03030'
          cctx.beginPath()
          cctx.arc(128, 128, 64, 0, Math.PI * 2)
          cctx.fill()
          const bmp = await createImageBitmap(cnv)
          const rbId = engine.addImageLayer(bmp, 'rb', 'bottom')!
          // Даём стору синхронизироваться — removeLayerBackground читает docJson.
          await new Promise((r) => setTimeout(r, 100))
          const { removeLayerBackground } = await import('./tools/removeBgTool')
          const t0 = performance.now()
          await removeLayerBackground(rbId)
          const ms = Math.round(performance.now() - t0)
          const comp = engine.readComposite()
          const at = (x: number, y: number): number => comp.pixels[(y * 256 + x) * 4 + 3]!
          const cornerAlpha = at(8, 8)
          const centerAlpha = at(128, 128)
          removeBgTest = {
            ms,
            cornerAlpha,
            centerAlpha,
            pass: cornerAlpha < 30 && centerAlpha > 200,
          }
        } catch (e) {
          removeBgTest = { pass: false, error: String(e) }
        }
      }
      const info = collectGlInfo()
      const selftest = runEngineSelfTest()
      window.slojka.smokeReport({
        ...info,
        engineSelfTest: selftest,
        slojkaRoundTrip,
        clipboardHotkeys,
        smartTest,
        removeBgTest,
      })
    })()
  }, [])

  const toggleLang = (): void => {
    const next: Lang = i18n.language === 'ru' ? 'en' : 'ru'
    void switchLanguage(next)
  }

  return (
    <div className="app">
      <TitleBar onAction={handleMenuAction} />
      <Toolbar />
      <div className="center-column">
        <TabBar />
        <ToolOptions />
        <CanvasView />
        {terminalOpen && <TerminalPanel onClose={() => setTerminalOpen(false)} />}
      </div>
      <LayersPanel />

      <footer className="statusbar">
        <span>
          {t('status.gpu')}: {glRenderer || '…'}
        </span>
        {glSoftware && <span className="software-warning">{t('status.softwareWarning')}</span>}
        {hasDoc && (
          <span>
            {t('status.zoom')}: {Math.round(zoom * 100)}%
          </span>
        )}
        {bgRemovalLayerId && (
          <span className="busy-chip">
            <span className="spinner" />
            {t('layers.ctxRemoveBgBusy')}
          </span>
        )}
        <span className="spacer" />
        <CursorCoords />
        <button
          className="lang-switch assistant-btn"
          title={t('terminal.buttonHint')}
          onClick={(e) => {
            // Снять фокус: Enter в терминале не должен «нажимать» кнопку снова.
            e.currentTarget.blur()
            setTerminalOpen((v) => !v)
          }}
        >
          🤖 {t('terminal.button')}
        </button>
        <button className="lang-switch" onClick={toggleLang}>
          {i18n.language === 'ru' ? 'EN' : 'РУ'}
        </button>
      </footer>

      <NewDocDialog />
      <FeatherDialog />
      <CanvasSizeDialog />
      <SettingsDialog />
      {recoverOpen && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h2>{t('recover.title')}</h2>
            <p>{t('recover.message')}</p>
            <div className="dialog-buttons">
              <button
                className="primary"
                onClick={() => {
                  setRecoverOpen(false)
                  void recoverAutosave()
                }}
              >
                {t('recover.restore')}
              </button>
              <button
                onClick={() => {
                  setRecoverOpen(false)
                  void discardAutosave()
                }}
              >
                {t('recover.discard')}
              </button>
            </div>
          </div>
        </div>
      )}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  )
}
