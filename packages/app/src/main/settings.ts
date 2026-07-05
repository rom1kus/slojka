import Store from 'electron-store'
import { DEFAULT_LANG, type Lang, LANGS } from '@slojka/shared'

interface SettingsSchema {
  language: Lang
  window: { width: number; height: number; maximized: boolean }
  /** Локальный ИИ (sidecar) включён пользователем. */
  aiEnabled: boolean
  /** Выбранный чекпойнт SAM 2.1. */
  samModel: 'tiny' | 'small' | 'base_plus' | 'large'
  /** API-ключ polza.ai, зашифрованный safeStorage (base64). */
  polzaKeyEnc?: string
  /** true, если ключ хранится без шифрования (нет keyring). */
  polzaKeyPlain?: boolean
  /** Бюджет памяти истории, МБ (читает renderer через settings:get). */
  historyMb?: number
  /** Прокси для встроенного терминала (claude); пусто — не задавать. */
  proxyHttp: string
  proxyHttps: string
}

export const settings = new Store<SettingsSchema>({
  name: 'config',
  defaults: {
    language: DEFAULT_LANG,
    window: { width: 1440, height: 900, maximized: false },
    aiEnabled: false,
    samModel: 'small',
    // Исторический дефолт этой (Linux-)машины; на прочих платформах прокси
    // не задаётся, пока пользователь не впишет его в настройках.
    proxyHttp: process.platform === 'linux' ? 'http://127.0.0.1:8118' : '',
    proxyHttps: process.platform === 'linux' ? 'http://127.0.0.1:10808' : '',
  },
})

export function getLanguage(): Lang {
  const lang = settings.get('language')
  return LANGS.includes(lang) ? lang : DEFAULT_LANG
}

export function setLanguage(lang: Lang): void {
  if (LANGS.includes(lang)) settings.set('language', lang)
}
