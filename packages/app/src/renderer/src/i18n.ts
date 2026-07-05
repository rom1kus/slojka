import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANG, resources, type Lang } from '@slojka/shared'

export async function initI18n(lang: Lang): Promise<void> {
  await i18next.use(initReactI18next).init({
    lng: lang,
    fallbackLng: DEFAULT_LANG,
    resources: {
      ru: { translation: resources.ru },
      en: { translation: resources.en },
    },
    interpolation: { escapeValue: false },
  })
}

export async function switchLanguage(lang: Lang): Promise<void> {
  await window.slojka.setLanguage(lang)
  await i18next.changeLanguage(lang)
}
