import { describe, expect, it } from 'vitest'
import {
  browserContextMenu,
  type BrowserMenuAbilities,
  type BrowserMenuAction,
  type BrowserMenuItem,
  type BrowserMenuParams,
} from './browser-context-menu.js'

const PARAMS: BrowserMenuParams = {
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  formControlType: 'none',
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
  },
}

const ABILITIES: BrowserMenuAbilities = {
  canGoBack: false,
  canGoForward: false,
  canOpenTab: true,
}

function menu(
  params: Partial<BrowserMenuParams> = {},
  abilities: Partial<BrowserMenuAbilities> = {}
): BrowserMenuItem[] {
  return browserContextMenu({ ...PARAMS, ...params }, { ...ABILITIES, ...abilities })
}

function ids(items: BrowserMenuItem[]): BrowserMenuAction[] {
  return items.flatMap((item) => (item.kind === 'item' ? [item.id] : []))
}

describe('browser context menu groups', () => {
  it('shows only navigation on a plain page and reflects history availability', () => {
    expect(menu({}, { canGoForward: true })).toEqual([
      { kind: 'item', id: 'back', enabled: false },
      { kind: 'item', id: 'forward', enabled: true },
      { kind: 'item', id: 'reload', enabled: true },
      { kind: 'item', id: 'inspect', enabled: true },
    ])
    expect(menu({}, { canGoBack: true })[0]).toMatchObject({ id: 'back', enabled: true })
  })

  it('adds link actions only for a navigable link', () => {
    const items = menu({ linkURL: 'https://example.com/link' })
    expect(ids(items)).toEqual([
      'link-new-tab',
      'link-external',
      'link-copy',
      'link-save',
      'back',
      'forward',
      'reload',
      'inspect',
    ])
    expect(items[4]).toEqual({ kind: 'separator' })
    for (const linkURL of ['', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(ids(menu({ linkURL }))).toEqual(['back', 'forward', 'reload', 'inspect'])
    }
  })

  it('keeps link and image groups on a linked image', () => {
    const items = menu({
      linkURL: 'https://example.com/link',
      srcURL: 'https://example.com/image.png',
      mediaType: 'image',
      hasImageContents: true,
    })
    expect(ids(items)).toEqual([
      'link-new-tab',
      'link-external',
      'link-copy',
      'link-save',
      'image-new-tab',
      'image-copy',
      'image-copy-address',
      'image-save',
      'back',
      'forward',
      'reload',
      'inspect',
    ])
    expect(items.filter((item) => item.kind === 'separator')).toHaveLength(2)
    expect(ids(menu({ srcURL: 'https://example.com/image.png' }))).not.toContain('image-copy')
  })

  it.each(['data:image/png;base64,YQ==', 'blob:https://example.com/image'])(
    'keeps image copy without URL actions for %s',
    (srcURL) => {
      const items = menu({ srcURL, mediaType: 'image', hasImageContents: true })
      expect(ids(items)).toEqual(['image-copy', 'back', 'forward', 'reload', 'inspect'])
      expect(items[0]).toEqual({ kind: 'item', id: 'image-copy', enabled: true })
      expect(menu({ srcURL, mediaType: 'image' })[0]).toMatchObject({ enabled: false })
    }
  )

  it('adds selection actions only for nonempty selected text', () => {
    const items = menu({
      selectionText: ' example.com ',
      editFlags: { ...PARAMS.editFlags, canCopy: true },
    })
    expect(items.slice(0, 2)).toEqual([
      { kind: 'item', id: 'selection-copy', enabled: true },
      { kind: 'item', id: 'selection-search', enabled: true },
    ])
    expect(ids(menu({ selectionText: ' \n\t ' }))).toEqual(['back', 'forward', 'reload', 'inspect'])
  })

  it('follows edit flags without adding a second Copy for an editable selection', () => {
    const items = menu({
      isEditable: true,
      formControlType: 'text-area',
      selectionText: 'selected text',
      editFlags: { ...PARAMS.editFlags, canUndo: true, canCopy: true, canSelectAll: true },
    })
    expect(ids(items)).toEqual([
      'selection-search',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'select-all',
      'back',
      'forward',
      'reload',
      'inspect',
    ])
    expect(items.filter((item) => item.kind === 'item' && item.enabled)).toEqual([
      { kind: 'item', id: 'selection-search', enabled: true },
      { kind: 'item', id: 'undo', enabled: true },
      { kind: 'item', id: 'copy', enabled: true },
      { kind: 'item', id: 'select-all', enabled: true },
      { kind: 'item', id: 'reload', enabled: true },
      { kind: 'item', id: 'inspect', enabled: true },
    ])
    expect(ids(menu({ isEditable: true }))).not.toContain('selection-search')
  })

  it('never enables Cut or Copy or offers search for a password field', () => {
    const items = menu({
      isEditable: true,
      formControlType: 'input-password',
      selectionText: 'revealed password',
      editFlags: { ...PARAMS.editFlags, canCut: true, canCopy: true, canPaste: true },
    })
    expect(ids(items)).not.toContain('selection-copy')
    expect(ids(items)).not.toContain('selection-search')
    expect(items.find((item) => item.kind === 'item' && item.id === 'cut')).toMatchObject({
      enabled: false,
    })
    expect(items.find((item) => item.kind === 'item' && item.id === 'copy')).toMatchObject({
      enabled: false,
    })
    expect(items.find((item) => item.kind === 'item' && item.id === 'paste')).toMatchObject({
      enabled: true,
    })
  })

  it('disables new tabs and search together while retaining other actions', () => {
    const items = menu(
      {
        linkURL: 'https://example.com/link',
        mediaType: 'image',
        srcURL: 'https://example.com/image.png',
        hasImageContents: true,
        selectionText: 'query',
      },
      { canOpenTab: false }
    )
    for (const id of ['link-new-tab', 'image-new-tab', 'selection-search']) {
      expect(items.find((item) => item.kind === 'item' && item.id === id)).toMatchObject({
        enabled: false,
      })
    }
    expect(items.find((item) => item.kind === 'item' && item.id === 'image-copy')).toMatchObject({
      enabled: true,
    })
  })

  it('puts separators only between groups and always ends in navigation', () => {
    const items = menu({
      linkURL: 'https://example.com/link',
      mediaType: 'image',
      srcURL: 'https://example.com/image.png',
      selectionText: 'query',
      isEditable: true,
    })
    expect(items[0]?.kind).toBe('item')
    expect(items.at(-1)?.kind).toBe('item')
    for (const [index, item] of items.entries()) {
      if (item.kind !== 'separator') continue
      expect(items[index - 1]?.kind).toBe('item')
      expect(items[index + 1]?.kind).toBe('item')
    }
    expect(ids(items).slice(-4)).toEqual(['back', 'forward', 'reload', 'inspect'])
    expect(items.filter((item) => item.kind === 'separator')).toHaveLength(4)
  })
})
