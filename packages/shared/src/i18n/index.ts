import { ru } from './ru'
import { en } from './en'

export type Lang = 'ru' | 'en'

export const LANGS: readonly Lang[] = ['ru', 'en']
export const DEFAULT_LANG: Lang = 'ru'

export const resources = { ru, en } as const

/**
 * Перевод по dot-пути ("menu.file"). Для main-процесса (меню, диалоги),
 * где i18next избыточен. Renderer использует i18next с теми же ресурсами.
 * Фолбэк: ru → сам ключ.
 */
export function t(lang: Lang, key: string): string {
  const val = lookup(resources[lang], key) ?? lookup(resources.ru, key)
  return typeof val === 'string' ? val : key
}

function lookup(dict: object, key: string): unknown {
  let cur: unknown = dict
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export { ru, en }
