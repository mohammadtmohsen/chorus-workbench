/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteProjectDialog } from './RemoteProjectDialog.js'

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.parentElement
    },
    configurable: true,
  })
})

let answerCheck: (value: unknown) => void = () => undefined

beforeEach(() => {
  ;(window as unknown as { chorus: Record<string, unknown> }).chorus = {
    setWorkbenchVisible: () => Promise.resolve({ stills: [] }),
    checkRemoteHost: () =>
      new Promise((resolve) => {
        answerCheck = resolve
      }),
  }
})

afterEach(() => {
  cleanup()
})

function openDialog(onAdd: (host: string, root: string) => Promise<void>): {
  readonly host: HTMLInputElement
  readonly root: HTMLInputElement
  readonly check: HTMLButtonElement
  readonly add: HTMLButtonElement
} {
  const { container } = render(<RemoteProjectDialog onClose={() => undefined} onAdd={onAdd} />)
  const findInput = (hook: string): HTMLInputElement => {
    const element = container.querySelector<HTMLInputElement>(`[${hook}]`)
    if (element === null) throw new Error(`The dialog has no ${hook}`)
    return element
  }
  const findButton = (hook: string): HTMLButtonElement => {
    const element = container.querySelector<HTMLButtonElement>(`[${hook}]`)
    if (element === null) throw new Error(`The dialog has no ${hook}`)
    return element
  }
  return {
    host: findInput('data-remote-host'),
    root: findInput('data-remote-root'),
    check: findButton('data-remote-check'),
    add: findButton('data-remote-add'),
  }
}

describe('RemoteProjectDialog', () => {
  it('keeps Add disabled until both fields hold something', () => {
    const { host, root, add } = openDialog(() => Promise.resolve())
    expect(add.disabled).toBe(true)
    fireEvent.change(host, { target: { value: 'officepc' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(root, { target: { value: '   ' } })
    expect(add.disabled).toBe(true)
    fireEvent.change(root, { target: { value: 'C:/api' } })
    expect(add.disabled).toBe(false)
  })

  it('disables Check and Add while a check runs, and frees them when it answers', async () => {
    const { host, root, check, add } = openDialog(() => Promise.resolve())
    fireEvent.change(host, { target: { value: 'officepc' } })
    fireEvent.change(root, { target: { value: 'C:/api' } })

    fireEvent.click(check)
    expect(check.disabled).toBe(true)
    expect(add.disabled).toBe(true)

    await act(async () => {
      answerCheck({ reachable: true, platform: 'win32-x64', quotingHolds: true, detail: '' })
      await new Promise((settle) => setTimeout(settle, 0))
    })
    expect(check.disabled).toBe(false)
    expect(add.disabled).toBe(false)
  })

  it('adds once with trimmed fields, however many times Add is pressed', () => {
    const onAdd = vi.fn((_host: string, _root: string) => new Promise<void>(() => undefined))
    const { host, root, add } = openDialog(onAdd)
    fireEvent.change(host, { target: { value: '  officepc ' } })
    fireEvent.change(root, { target: { value: ' C:/api  ' } })

    fireEvent.click(add)
    fireEvent.click(add)
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('officepc', 'C:/api')
  })
})
