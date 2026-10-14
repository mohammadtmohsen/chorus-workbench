import { describe, expect, it } from 'vitest'
import en from '../renderer/src/i18n/en.json'
import type { BrowserMenuAction } from './browser-context-menu.js'
import { mainT } from './i18n.js'

const labels: Readonly<Record<BrowserMenuAction, string>> = en.browserMenu

describe('main browser menu translations', () => {
  it.each(Object.entries(labels))('translates %s on first use', (action, label) => {
    expect(mainT(`browserMenu.${action}`)).toBe(label)
  })

  it('interpolates selected text without HTML escaping', () => {
    const text = 'example.com & <text>'
    expect(mainT('browserMenu.selection-search', { text })).toBe(
      labels['selection-search'].replace('{{text}}', text)
    )
  })
})
