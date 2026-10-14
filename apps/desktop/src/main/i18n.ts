import i18next from 'i18next'
import en from '../renderer/src/i18n/en.json'

const instance = i18next.createInstance()
void instance.init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export const mainT = instance.t.bind(instance)
