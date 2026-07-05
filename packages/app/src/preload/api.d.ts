import type { SlojkaApi } from './index'

declare global {
  interface Window {
    slojka: SlojkaApi
  }
}

export {}
