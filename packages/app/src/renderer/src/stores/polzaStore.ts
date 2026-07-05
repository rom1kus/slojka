import { create } from 'zustand'

export interface PolzaJob {
  id: string
  polza_id: string | null
  kind: string
  model: string
  request_json: string
  status: string
  error: string | null
  cost_rub: number | null
  result_files: string[]
  created_at: number
  updated_at: number
}

export interface PromptPreset {
  id: string
  title: string
  text: string
  tags: string[]
}

export interface PolzaModel {
  id: string
  name: string
}

/**
 * Стартовый список image-моделей по документации polza.ai (ID из гайдов
 * /docs/gaidy/*); обновляется живым GET /api/v1/models?type=image.
 */
export const DEFAULT_MODELS: PolzaModel[] = [
  { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana' },
  { id: 'google/gemini-3-pro-image-preview', name: 'Nano Banana Pro' },
  { id: 'google/gemini-3.1-flash-image-preview', name: 'Nano Banana 2' },
  { id: 'bytedance/seedream-4.5', name: 'Seedream 4.5' },
  { id: 'bytedance/seedream-5-lite', name: 'Seedream 5.0 Lite' },
  { id: 'bytedance/seedream-4', name: 'Seedream 4' },
  { id: 'bytedance/seedream', name: 'Seedream 3.0' },
  { id: 'openai/gpt-image-1.5', name: 'GPT Image 1.5' },
  { id: 'openai/gpt-5-image', name: 'GPT-5 Image' },
  { id: 'openai/gpt-5-image-mini', name: 'GPT-5 Image Mini' },
  { id: 'openai/gpt-5.4-image-2', name: 'GPT-5.4 Image 2' },
  { id: 'black-forest-labs/flux.2-pro', name: 'Flux-2 Pro' },
  { id: 'black-forest-labs/flux.2-flex', name: 'Flux-2 Flex' },
  { id: 'x-ai/grok-imagine-image', name: 'Grok Imagine' },
  { id: 'qwen/image', name: 'Qwen Image' },
  { id: 'topaz/image-upscale', name: 'Topaz Upscale' },
]

/** Выделенная модель апскейла (вкладка «Апскейл» всегда использует её). */
export const UPSCALE_MODEL = 'topaz/image-upscale'

interface PolzaState {
  hasKey: boolean
  keyInput: string
  models: PolzaModel[]
  model: string
  prompt: string
  aspectRatio: string
  maxImages: number
  seed: string
  jobs: PolzaJob[]
  busy: boolean
  error: string | null
  panelOpen: boolean
  libraryOpen: boolean
  prompts: PromptPreset[]

  set: (patch: Partial<PolzaState>) => void
}

export const usePolzaStore = create<PolzaState>((set) => ({
  hasKey: false,
  keyInput: '',
  models: [...DEFAULT_MODELS],
  model: DEFAULT_MODELS[0]!.id,
  prompt: '',
  aspectRatio: '1:1',
  maxImages: 1,
  seed: '',
  jobs: [],
  busy: false,
  error: null,
  panelOpen: false,
  libraryOpen: false,
  prompts: [],

  set: (patch) => set(patch),
}))
