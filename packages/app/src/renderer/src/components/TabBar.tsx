import { useEditorStore } from '../stores/editorStore'
import { closeTab, copyLayerToTab, switchTab, useTabsStore } from '../io/tabs'

/** Вкладки документов; принимают drop слоя (перенос между документами). */
export function TabBar(): React.JSX.Element | null {
  const tabs = useTabsStore((s) => s.tabs)
  const activeId = useTabsStore((s) => s.activeId)
  const dirty = useEditorStore((s) => s.dirty)
  const fileName = useEditorStore((s) => s.fileName)

  if (tabs.length === 0) return null

  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        const label = isActive ? (fileName ?? tab.name) : tab.name
        const isDirty = isActive ? dirty : tab.dirty
        return (
          <div
            key={tab.id}
            className={`doc-tab ${isActive ? 'active' : ''}`}
            title={tab.filePath ?? label}
            onClick={() => void switchTab(tab.id)}
            onDragOver={(e) => {
              // Слой из панели слоёв можно бросить на вкладку.
              e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              const layerId = e.dataTransfer.getData('slojka/layer-id')
              if (layerId) void copyLayerToTab(layerId, tab.id)
            }}
          >
            <span className="doc-tab-name">
              {isDirty ? '• ' : ''}
              {label}
            </span>
            <button
              className="doc-tab-close"
              title="Закрыть"
              onClick={(e) => {
                e.stopPropagation()
                void closeTab(tab.id)
              }}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
