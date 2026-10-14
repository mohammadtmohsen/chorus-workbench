import type { ContextMenuParams } from 'electron'
import { browserSearchUrl, isBrowserNavigable } from '../shared/browser-ipc.js'

export type BrowserMenuAction =
  | 'link-new-tab'
  | 'link-external'
  | 'link-copy'
  | 'link-save'
  | 'image-new-tab'
  | 'image-copy'
  | 'image-copy-address'
  | 'image-save'
  | 'selection-copy'
  | 'selection-search'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'back'
  | 'forward'
  | 'reload'
  | 'inspect'

export type BrowserMenuItem =
  | { readonly kind: 'separator' }
  | { readonly kind: 'item'; readonly id: BrowserMenuAction; readonly enabled: boolean }

export interface BrowserMenuAbilities {
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly canOpenTab: boolean
}

export type BrowserMenuParams = Pick<
  ContextMenuParams,
  | 'linkURL'
  | 'srcURL'
  | 'mediaType'
  | 'hasImageContents'
  | 'isEditable'
  | 'selectionText'
  | 'editFlags'
  | 'formControlType'
>

function item(id: BrowserMenuAction, enabled = true): BrowserMenuItem {
  return { kind: 'item', id, enabled }
}

export function browserContextMenu(
  params: BrowserMenuParams,
  abilities: BrowserMenuAbilities
): BrowserMenuItem[] {
  const groups: BrowserMenuItem[][] = []
  if (isBrowserNavigable(params.linkURL)) {
    groups.push([
      item('link-new-tab', abilities.canOpenTab),
      item('link-external'),
      item('link-copy'),
      item('link-save'),
    ])
  }
  if (params.mediaType === 'image') {
    const image: BrowserMenuItem[] = []
    const navigable = isBrowserNavigable(params.srcURL)
    if (navigable) image.push(item('image-new-tab', abilities.canOpenTab))
    image.push(item('image-copy', params.hasImageContents))
    if (navigable) image.push(item('image-copy-address'), item('image-save'))
    groups.push(image)
  }
  const password = params.formControlType === 'input-password'
  if (params.selectionText.trim() !== '' && !password) {
    const selection: BrowserMenuItem[] = []
    if (!params.isEditable) selection.push(item('selection-copy', params.editFlags.canCopy))
    selection.push(
      item(
        'selection-search',
        abilities.canOpenTab && browserSearchUrl(params.selectionText) !== null
      )
    )
    groups.push(selection)
  }
  if (params.isEditable) {
    const flags = params.editFlags
    groups.push([
      item('undo', flags.canUndo),
      item('redo', flags.canRedo),
      item('cut', !password && flags.canCut),
      item('copy', !password && flags.canCopy),
      item('paste', flags.canPaste),
      item('select-all', flags.canSelectAll),
    ])
  }
  groups.push([
    item('back', abilities.canGoBack),
    item('forward', abilities.canGoForward),
    item('reload'),
    item('inspect'),
  ])
  return groups.flatMap((group, index): BrowserMenuItem[] =>
    index === 0 ? group : [{ kind: 'separator' }, ...group]
  )
}
