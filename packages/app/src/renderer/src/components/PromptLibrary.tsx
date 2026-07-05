import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePolzaStore, type PromptPreset } from '../stores/polzaStore'
import { loadPrompts, savePrompts } from '../io/polzaOps'

/** Библиотека промтов: поиск/теги, вставка в поле промта, CRUD. */
export function PromptLibrary(): React.JSX.Element | null {
  const { t } = useTranslation()
  const open = usePolzaStore((s) => s.libraryOpen)
  const prompts = usePolzaStore((s) => s.prompts)
  const set = usePolzaStore((s) => s.set)
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<PromptPreset | null>(null)

  useEffect(() => {
    if (open) void loadPrompts()
  }, [open])

  if (!open) return null

  const close = (): void => {
    set({ libraryOpen: false })
    setEditing(null)
  }

  const filtered = prompts.filter((p) => {
    const q = filter.toLowerCase()
    return (
      !q ||
      p.title.toLowerCase().includes(q) ||
      p.text.toLowerCase().includes(q) ||
      p.tags.some((tag) => tag.toLowerCase().includes(q))
    )
  })

  const saveEditing = (): void => {
    if (!editing || !editing.title.trim()) return
    const rest = prompts.filter((p) => p.id !== editing.id)
    void savePrompts([...rest, editing].sort((a, b) => a.title.localeCompare(b.title, 'ru')))
    setEditing(null)
  }

  return (
    <div className="dialog-backdrop" onClick={close}>
      <div className="dialog library-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('promptLib.title')}</h2>
        <div className="dialog-row">
          <input
            placeholder={t('promptLib.search')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            onClick={() =>
              setEditing({ id: crypto.randomUUID(), title: '', text: '', tags: [] })
            }
          >
            + {t('promptLib.add')}
          </button>
        </div>

        {editing ? (
          <div className="prompt-edit">
            <input
              autoFocus
              placeholder={t('promptLib.name')}
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
            />
            <textarea
              rows={5}
              className="text-content"
              placeholder={t('promptLib.text')}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            />
            <input
              placeholder={t('promptLib.tags')}
              value={editing.tags.join(', ')}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
            />
            <div className="dialog-buttons">
              <button className="primary" onClick={saveEditing}>
                {t('common.ok')}
              </button>
              <button onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        ) : (
          <div className="prompt-list">
            {filtered.length === 0 && <p className="opt-hint">{t('promptLib.empty')}</p>}
            {filtered.map((p) => (
              <div key={p.id} className="prompt-row">
                <div className="prompt-info">
                  <b>{p.title}</b>
                  {p.tags.length > 0 && <span className="prompt-tags">{p.tags.join(' · ')}</span>}
                  <span className="prompt-preview">{p.text.slice(0, 80)}</span>
                </div>
                <button
                  className="style-btn wide"
                  title={t('promptLib.insert')}
                  onClick={() => {
                    set({ prompt: p.text, libraryOpen: false })
                  }}
                >
                  ⤴
                </button>
                <button className="style-btn" onClick={() => setEditing({ ...p })}>
                  ✎
                </button>
                <button
                  className="style-btn"
                  onClick={() => void savePrompts(prompts.filter((x) => x.id !== p.id))}
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="dialog-buttons">
          <button onClick={close}>{t('common.ok')}</button>
        </div>
      </div>
    </div>
  )
}
