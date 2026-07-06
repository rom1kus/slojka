import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Lang } from '@slojka/shared'
import { editor } from '../controller/EditorController'
import { switchLanguage } from '../i18n'
import { refreshAiStatus, useAiStore, type SamModelSize } from '../stores/aiStore'

const SAM_MODELS: { id: SamModelSize; label: string }[] = [
  { id: 'tiny', label: 'Tiny (156 МБ, быстрее)' },
  { id: 'small', label: 'Small (184 МБ, рекомендуется)' },
  { id: 'base_plus', label: 'Base+ (324 МБ, качественнее)' },
  { id: 'large', label: 'Large (898 МБ, максимум)' },
]

export function SettingsDialog(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const open = useAiStore((s) => s.settingsOpen)
  const setOpen = useAiStore((s) => s.setSettingsOpen)
  const ai = useAiStore()
  const [samModel, setSamModel] = useState<SamModelSize>('small')
  const [confirmSam, setConfirmSam] = useState(false)
  const [historyMb, setHistoryMb] = useState(256)
  const [proxyHttp, setProxyHttp] = useState('')
  const [proxyHttps, setProxyHttps] = useState('')

  useEffect(() => {
    if (open) {
      void refreshAiStatus()
      void window.slojka.getSetting('samModel').then((m) => {
        if (typeof m === 'string') setSamModel(m as SamModelSize)
      })
      void window.slojka.getSetting('historyMb').then((v) => {
        if (typeof v === 'number') setHistoryMb(v)
      })
      void window.slojka.getSetting('proxyHttp').then((v) => {
        if (typeof v === 'string') setProxyHttp(v)
      })
      void window.slojka.getSetting('proxyHttps').then((v) => {
        if (typeof v === 'string') setProxyHttps(v)
      })
    }
  }, [open])

  const applyHistoryMb = (mb: number): void => {
    const clamped = Math.max(64, Math.min(2048, Math.round(mb) || 256))
    setHistoryMb(clamped)
    editor.setHistoryBudgetMb(clamped)
    void window.slojka.setSetting('historyMb', clamped)
  }

  if (!open) return null

  const run = async (fn: () => Promise<void>): Promise<void> => {
    const store = useAiStore.getState()
    store.setBusy(true)
    try {
      await fn()
    } catch (e) {
      store.setProgress({ stage: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      store.setBusy(false)
      await refreshAiStatus()
    }
  }

  const enableAi = (): Promise<void> =>
    run(async () => {
      await window.slojka.aiEnable()
      await window.slojka.setSetting('aiEnabled', true)
    })

  const disableAi = (): Promise<void> =>
    run(async () => {
      await window.slojka.aiDisable()
      await window.slojka.setSetting('aiEnabled', false)
    })

  const installSam = (): Promise<void> =>
    run(async () => {
      setConfirmSam(false)
      await window.slojka.setSetting('samModel', samModel)
      await window.slojka.aiInstallSam(samModel)
    })

  const loadSam = (): Promise<void> =>
    run(async () => {
      await window.slojka.setSetting('samModel', samModel)
      await window.slojka.aiSamLoad(samModel)
    })

  const samInstalled = ai.sam?.installed ?? false

  return (
    <div className="dialog-backdrop" onClick={() => !ai.busy && setOpen(false)}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settingsDlg.title')}</h2>

        <label className="dialog-row">
          <span>{t('settings.language')}</span>
          <select
            value={i18n.language}
            onChange={(e) => void switchLanguage(e.target.value as Lang)}
          >
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>

        <label className="dialog-row">
          <span>{t('settingsDlg.historyMb')}</span>
          <input
            type="number"
            min={64}
            max={2048}
            step={64}
            value={historyMb}
            onChange={(e) => applyHistoryMb(Number(e.target.value))}
          />
          <span className="opt-hint">{t('settingsDlg.historyMbHint')}</span>
        </label>

        <fieldset className="style-group">
          <legend>{t('settingsDlg.netSection')}</legend>
          <p className="opt-hint">{t('settingsDlg.proxyHint')}</p>
          <label className="dialog-row">
            <span>{t('settingsDlg.proxyHttp')}</span>
            <input
              type="text"
              placeholder="http://127.0.0.1:8118"
              value={proxyHttp}
              onChange={(e) => {
                setProxyHttp(e.target.value)
                void window.slojka.setSetting('proxyHttp', e.target.value.trim())
              }}
            />
          </label>
          <label className="dialog-row">
            <span>{t('settingsDlg.proxyHttps')}</span>
            <input
              type="text"
              placeholder="http://127.0.0.1:10808"
              value={proxyHttps}
              onChange={(e) => {
                setProxyHttps(e.target.value)
                void window.slojka.setSetting('proxyHttps', e.target.value.trim())
              }}
            />
          </label>
        </fieldset>

        <fieldset className="style-group">
          <legend>{t('settingsDlg.aiSection')}</legend>
          <p className="opt-hint">{t('settingsDlg.aiHint')}</p>
          {!ai.pythonFound && <p className="dialog-warning">{t('settingsDlg.noPython')}</p>}

          <div className="dialog-row">
            <span>{t('settingsDlg.aiState')}</span>
            <b>{t(`settingsDlg.state.${ai.state}`)}</b>
            {ai.state === 'absent' ? (
              <button disabled={ai.busy || !ai.pythonFound} onClick={() => void enableAi()}>
                {t('settingsDlg.enableAi')}
              </button>
            ) : (
              <button disabled={ai.busy} onClick={() => void disableAi()}>
                {t('settingsDlg.disableAi')}
              </button>
            )}
          </div>

          {ai.state === 'ready' && (
            <>
              <div className="dialog-row">
                <span>SAM 2.1</span>
                <b>
                  {ai.sam?.loaded
                    ? t('settingsDlg.samLoaded', {
                        model: ai.sam.model_size,
                        device: ai.sam.device,
                      })
                    : samInstalled
                      ? t('settingsDlg.samNotLoaded')
                      : t('settingsDlg.samNotInstalled')}
                </b>
              </div>
              <div className="dialog-row">
                <span>{t('settingsDlg.samModel')}</span>
                <select
                  value={samModel}
                  disabled={ai.busy}
                  onChange={(e) => setSamModel(e.target.value as SamModelSize)}
                >
                  {SAM_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {samInstalled ? (
                  <button disabled={ai.busy} onClick={() => void loadSam()}>
                    {t('settingsDlg.samLoad')}
                  </button>
                ) : (
                  <button disabled={ai.busy} onClick={() => setConfirmSam(true)}>
                    {t('settingsDlg.samInstall')}
                  </button>
                )}
              </div>
              {confirmSam && (
                <div className="confirm-box">
                  <p>{t('settingsDlg.samConfirm')}</p>
                  <div className="dialog-buttons">
                    <button className="primary" onClick={() => void installSam()}>
                      {t('settingsDlg.samConfirmYes')}
                    </button>
                    <button onClick={() => setConfirmSam(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              )}
            </>
          )}

          {ai.progress && (
            <div className="ai-progress">
              <span className="ai-progress-row">
                {ai.progress.stage !== 'done' && ai.progress.stage !== 'error' && (
                  <span className="spinner" />
                )}
                <span className="ai-progress-msg">{ai.progress.message}</span>
              </span>
              {ai.progress.stage !== 'done' && ai.progress.stage !== 'error' && (
                <>
                  {ai.progress.pct !== undefined ? (
                    <progress value={ai.progress.pct} max={1} style={{ width: '100%' }} />
                  ) : (
                    // Процент неизвестен (venv, распаковка pip) — «живая» полоса:
                    // видно, что установка идёт, а не зависла.
                    <div className="progress-indeterminate" />
                  )}
                  <span className="opt-hint">{t('settingsDlg.installHint')}</span>
                </>
              )}
            </div>
          )}
        </fieldset>

        <div className="dialog-buttons">
          <button disabled={ai.busy} onClick={() => setOpen(false)}>
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  )
}
