import { describe, expect, it } from 'vitest'
import { ru } from '../src/i18n/ru'
import { en } from '../src/i18n/en'
import { t } from '../src/i18n/index'

function keysOf(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keysOf(v as object, `${prefix}${k}.`),
  )
}

describe('i18n', () => {
  it('en зеркалит все ключи ru (и наоборот)', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(ru).sort())
  })

  it('t() ищет по dot-пути с фолбэком на ru и на сам ключ', () => {
    expect(t('ru', 'menu.file')).toBe('Файл')
    expect(t('en', 'menu.file')).toBe('File')
    expect(t('en', 'nope.missing')).toBe('nope.missing')
  })

  it('нет пустых переводов', () => {
    const check = (obj: object, path: string): void => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') expect(v.length, `${path}${k}`).toBeGreaterThan(0)
        else check(v as object, `${path}${k}.`)
      }
    }
    check(ru, '')
    check(en, '')
  })
})
