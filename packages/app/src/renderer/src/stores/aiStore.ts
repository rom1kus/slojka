import { create } from 'zustand'

export type AiState = 'absent' | 'starting' | 'ready' | 'error'
export type SamModelSize = 'tiny' | 'small' | 'base_plus' | 'large'

export interface SamStatus {
  installed: boolean
  loaded: boolean
  model_size: string | null
  device: string | null
}

interface AiStoreState {
  state: AiState
  pythonFound: boolean
  baseInstalled: boolean
  sam: SamStatus | null
  checkpoints: string[]
  busy: boolean
  progress: { stage: string; message: string; pct?: number } | null
  settingsOpen: boolean

  setSettingsOpen: (open: boolean) => void
  setBusy: (busy: boolean) => void
  setProgress: (p: AiStoreState['progress']) => void
  setState: (s: AiState) => void
  applyStatus: (s: {
    python: string | null
    baseInstalled: boolean
    state: AiState
    sam: SamStatus | null
    checkpoints: string[]
  }) => void
}

export const useAiStore = create<AiStoreState>((set) => ({
  state: 'absent',
  pythonFound: false,
  baseInstalled: false,
  sam: null,
  checkpoints: [],
  busy: false,
  progress: null,
  settingsOpen: false,

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setBusy: (busy) => set({ busy }),
  setProgress: (progress) => set({ progress }),
  setState: (state) => set({ state }),
  applyStatus: (s) =>
    set({
      pythonFound: s.python !== null,
      baseInstalled: s.baseInstalled,
      state: s.state,
      sam: s.sam,
      checkpoints: s.checkpoints,
    }),
}))

export async function refreshAiStatus(): Promise<void> {
  const status = await window.slojka.aiStatus()
  useAiStore.getState().applyStatus(status)
}

/** SAM готов к использованию как инструмент. */
export function samReady(): boolean {
  const s = useAiStore.getState()
  return s.state === 'ready' && (s.sam?.loaded ?? false)
}
