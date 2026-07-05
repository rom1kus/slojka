import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiStore } from '../stores/aiStore'
import { useEditorStore } from '../stores/editorStore'
import { usePolzaStore } from '../stores/polzaStore'
import {
  cancelJob,
  clearFinishedJobs,
  insertResult,
  refreshJobs,
  refreshModels,
  refreshPolzaStatus,
  removeJob,
  savePolzaKey,
  submitGenerate,
  submitObjectEdit,
  submitUpscale,
} from '../io/polzaOps'
import { PromptLibrary } from './PromptLibrary'

const STATUS_KEY: Record<string, string> = {
  pending: 'polza.stPending',
  processing: 'polza.stProcessing',
  completed: 'polza.stCompleted',
  failed: 'polza.stFailed',
  cancelled: 'polza.stCancelled',
  timeout: 'polza.stTimeout',
}

export function AiPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const s = usePolzaStore()
  const aiReady = useAiStore((st) => st.state === 'ready')
  const hasDoc = useEditorStore((st) => st.docJson !== null)
  const hasSelection = useEditorStore((st) => st.hasSelection)
  const setSettingsOpen = useAiStore((st) => st.setSettingsOpen)

  // Постоянный поллинг живёт в App (startJobPolling); здесь — только
  // немедленное обновление при открытии панели.
  useEffect(() => {
    if (!s.panelOpen || !aiReady) return
    void refreshPolzaStatus()
    void refreshJobs()
  }, [s.panelOpen, aiReady])

  return (
    <div className="ai-panel">
      <div
        className="panel-header collapsible"
        onClick={() => s.set({ panelOpen: !s.panelOpen })}
      >
        {s.panelOpen ? '▾' : '▸'} {t('polza.title')}
      </div>
      {s.panelOpen && (
        <div className="ai-panel-body">
          {!aiReady ? (
            <p className="opt-hint">
              {t('polza.needSidecar')}{' '}
              <button className="link-btn" onClick={() => setSettingsOpen(true)}>
                {t('polza.openSettings')}
              </button>
            </p>
          ) : !s.hasKey ? (
            <div className="dialog-row">
              <input
                type="password"
                placeholder={t('polza.keyPlaceholder')}
                value={s.keyInput}
                onChange={(e) => s.set({ keyInput: e.target.value })}
              />
              <button disabled={!s.keyInput.trim()} onClick={() => void savePolzaKey()}>
                {t('polza.keySave')}
              </button>
            </div>
          ) : (
            <>
              <div className="dialog-row">
                <select
                  value={s.model}
                  onChange={(e) => s.set({ model: e.target.value })}
                  title={t('polza.model')}
                >
                  {!s.models.some((m) => m.id === s.model) && (
                    <option value={s.model}>{s.model}</option>
                  )}
                  {s.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  className="style-btn wide"
                  title={t('polza.refreshModels')}
                  onClick={() => void refreshModels()}
                >
                  ⟳
                </button>
                <button
                  className="style-btn wide"
                  title={t('polza.changeKey')}
                  onClick={() => s.set({ hasKey: false })}
                >
                  🔑
                </button>
              </div>
              <input
                className="model-custom"
                value={s.model}
                onChange={(e) => s.set({ model: e.target.value })}
                placeholder={t('polza.modelCustom')}
              />

              <textarea
                className="text-content prompt-input"
                rows={3}
                placeholder={t('polza.promptPlaceholder')}
                value={s.prompt}
                onChange={(e) => s.set({ prompt: e.target.value })}
              />
              <div className="dialog-row">
                <button className="style-btn wide" onClick={() => s.set({ libraryOpen: true })}>
                  📚 {t('polza.library')}
                </button>
                <select
                  value={s.aspectRatio}
                  onChange={(e) => s.set({ aspectRatio: e.target.value })}
                  title={t('polza.aspect')}
                >
                  {['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                <select
                  value={s.maxImages}
                  onChange={(e) => s.set({ maxImages: Number(e.target.value) })}
                  title={t('polza.count')}
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      ×{n}
                    </option>
                  ))}
                </select>
                <input
                  className="seed-input"
                  placeholder="seed"
                  value={s.seed}
                  onChange={(e) => s.set({ seed: e.target.value })}
                />
              </div>

              <div className="dialog-row">
                <button
                  className="primary-btn"
                  disabled={s.busy || !s.prompt.trim()}
                  onClick={() => void submitGenerate()}
                >
                  {t('polza.generate')}
                </button>
                {hasDoc && (
                  <>
                    <button disabled={s.busy} onClick={() => void submitUpscale('2x')}>
                      ×2
                    </button>
                    <button disabled={s.busy} onClick={() => void submitUpscale('4x')}>
                      ×4
                    </button>
                  </>
                )}
              </div>

              {hasDoc && (
                <div className="dialog-row">
                  <button
                    disabled={s.busy || !hasSelection}
                    title={t('polza.removeHint')}
                    onClick={() => void submitObjectEdit('remove')}
                  >
                    {t('polza.removeObject')}
                  </button>
                  <button
                    disabled={s.busy || !hasSelection || !s.prompt.trim()}
                    title={t('polza.replaceHint')}
                    onClick={() => void submitObjectEdit('replace')}
                  >
                    {t('polza.replaceObject')}
                  </button>
                </div>
              )}

              {s.error && (
                <p className="dialog-warning">
                  {s.error}{' '}
                  <button
                    className="style-btn"
                    title={t('common.close')}
                    onClick={() => s.set({ error: null })}
                  >
                    ✕
                  </button>
                </p>
              )}

              {s.jobs.some((j) => j.status !== 'pending' && j.status !== 'processing') && (
                <div className="dialog-row">
                  <button className="style-btn wide" onClick={() => void clearFinishedJobs()}>
                    🗑 {t('polza.clearJobs')}
                  </button>
                </div>
              )}
              <div className="job-list">
                {s.jobs.map((job) => (
                  <div key={job.id} className={`job-row st-${job.status}`} title={job.model}>
                    <span className="job-kind">{t(`polza.kind.${job.kind}`, job.kind)}</span>
                    <span className="job-status">
                      {t(STATUS_KEY[job.status] ?? 'polza.stPending')}
                      {job.cost_rub != null && ` · ${job.cost_rub.toFixed(2)}₽`}
                    </span>
                    {job.status === 'pending' || job.status === 'processing' ? (
                      <button
                        className="style-btn"
                        title={t('polza.cancelJob')}
                        onClick={() => void cancelJob(job.id)}
                      >
                        ✕
                      </button>
                    ) : (
                      <button
                        className="style-btn"
                        title={t('polza.removeJob')}
                        onClick={() => void removeJob(job.id)}
                      >
                        ✕
                      </button>
                    )}
                    {job.status === 'completed' &&
                      job.result_files.map((_, i) => (
                        <button
                          key={i}
                          className="style-btn wide"
                          title={t('polza.insert')}
                          onClick={() => void insertResult(job.id, i)}
                        >
                          ⤵ {job.result_files.length > 1 ? i + 1 : ''}
                        </button>
                      ))}
                    {job.error && <span className="job-error">{job.error}</span>}
                  </div>
                ))}
              </div>
              <p className="opt-hint">
                {t('polza.total')}:{' '}
                {s.jobs.reduce((sum, j) => sum + (j.cost_rub ?? 0), 0).toFixed(2)}₽
              </p>
            </>
          )}
        </div>
      )}
      <PromptLibrary />
    </div>
  )
}
