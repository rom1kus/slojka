import { editor } from '../controller/EditorController'
import { useEditorStore } from '../stores/editorStore'

/** Применить рамку кадрирования (Enter / двойной клик / кнопка «Применить»). */
export function applyCrop(): void {
  const { cropRect, setCropRect } = useEditorStore.getState()
  if (!cropRect || cropRect.w < 1 || cropRect.h < 1) return
  editor.resizeCanvas(cropRect.w, cropRect.h, -cropRect.x, -cropRect.y, 'history.crop')
  setCropRect(null)
}

/** Убрать рамку кадрирования (Esc / кнопка «Отмена»). */
export function cancelCrop(): void {
  useEditorStore.getState().setCropRect(null)
}
