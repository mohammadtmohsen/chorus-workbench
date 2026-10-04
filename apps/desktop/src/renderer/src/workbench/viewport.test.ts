import { describe, expect, it } from 'vitest'
import {
  addsIframe,
  horizontalRowWheel,
  isCropped,
  leftActivityBarWidth,
  trackModifiers,
  watchWheelSources,
} from './viewport.js'

describe('horizontal wheel gestures over the editor', () => {
  const wheel = (overrides: Partial<Parameters<typeof horizontalRowWheel>[0]>) => ({
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  })

  it('keeps horizontal direction and supports Shift with a vertical wheel', () => {
    expect(horizontalRowWheel(wheel({ deltaX: 120, deltaY: 3 }), 800)).toBe(120)
    expect(horizontalRowWheel(wheel({ deltaX: -40, deltaY: 2 }), 800)).toBe(-40)
    expect(horizontalRowWheel(wheel({ deltaY: 60, shiftKey: true }), 800)).toBe(60)
  })

  it('leaves vertical scrolling and modified zoom gestures inside the workbench', () => {
    expect(horizontalRowWheel(wheel({ deltaY: 90 }), 800)).toBe(0)
    expect(horizontalRowWheel(wheel({ deltaX: 2, deltaY: 50 }), 800)).toBe(0)
    expect(horizontalRowWheel(wheel({ deltaX: 120, ctrlKey: true }), 800)).toBe(0)
    expect(horizontalRowWheel(wheel({ deltaX: 120, metaKey: true }), 800)).toBe(0)
  })

  it('normalizes line and page units and ignores unusable deltas', () => {
    expect(horizontalRowWheel(wheel({ deltaX: 2, deltaMode: 1 }), 800)).toBe(32)
    expect(horizontalRowWheel(wheel({ deltaX: -1, deltaMode: 2 }), 800)).toBe(-800)
    expect(horizontalRowWheel(wheel({ deltaX: 120, deltaMode: 3 }), 800)).toBe(0)
    expect(horizontalRowWheel(wheel({ deltaX: Number.NaN }), 800)).toBe(0)
    expect(horizontalRowWheel(wheel({ deltaX: Number.POSITIVE_INFINITY }), 800)).toBe(0)
  })
})

describe('whether the workbench is cropped', () => {
  it('is cropped only when the viewport is narrower than the root by more than a pixel', () => {
    expect(isCropped(600, 900)).toBe(true)
    expect(isCropped(898, 900)).toBe(true)
    expect(isCropped(899, 900)).toBe(false)
    expect(isCropped(900, 900)).toBe(false)
    expect(isCropped(1_200, 900)).toBe(false)
  })
})

describe('the activity bar width reported to the shell', () => {
  it('reports the bar on the left edge, at its own width', () => {
    expect(leftActivityBarWidth({ left: 0, width: 48 }, 0)).toBe(48)
    expect(leftActivityBarWidth({ left: 0, width: 36 }, 0)).toBe(36)
  })

  it('tolerates sub-pixel geometry', () => {
    expect(leftActivityBarWidth({ left: 0.4, width: 47.6 }, 0)).toBe(48)
    expect(leftActivityBarWidth({ left: 12.6, width: 48 }, 12)).toBe(48)
  })

  it('reserves nothing for a bar that is hidden, empty or on the right', () => {
    expect(leftActivityBarWidth(null, 0)).toBe(0)
    expect(leftActivityBarWidth({ left: 0, width: 0 }, 0)).toBe(0)
    expect(leftActivityBarWidth({ left: 852, width: 48 }, 0)).toBe(0)
  })
})

describe('wheels from webviews', () => {
  function source(): {
    readonly onDidWheel: (listener: (event: object) => void) => void
    readonly fire: (event: object) => void
    readonly listeners: ((event: object) => void)[]
  } {
    const listeners: ((event: object) => void)[] = []
    return {
      onDidWheel: (listener) => {
        listeners.push(listener)
      },
      fire: (event) => {
        for (const listener of listeners) listener(event)
      },
      listeners,
    }
  }

  it('forwards a wheel once when an overlay re-fires its inner webview', () => {
    const element = source()
    const overlay = source()
    element.onDidWheel((event) => {
      overlay.fire(event)
    })
    const forwarded: object[] = []
    const watch = watchWheelSources<ReturnType<typeof source>, object>((event) => {
      forwarded.push(event)
    })

    watch([overlay, element])
    const first = { deltaX: 40 }
    const second = { deltaX: -40 }
    element.fire(first)
    element.fire(second)

    expect(forwarded).toHaveLength(2)
    expect(forwarded[0]).toBe(first)
    expect(forwarded[1]).toBe(second)
  })

  it('subscribes each webview once, and picks up one mounted later', () => {
    const existing = source()
    const later = source()
    const forwarded: object[] = []
    const watch = watchWheelSources<ReturnType<typeof source>, object>((event) => {
      forwarded.push(event)
    })

    watch([existing])
    watch([existing])
    watch([existing, later])
    const wheel = { deltaX: 12 }
    later.fire(wheel)

    expect(existing.listeners).toHaveLength(1)
    expect(later.listeners).toHaveLength(1)
    expect(forwarded).toEqual([wheel])
  })
})

describe('modifiers for wheels that arrive without them', () => {
  const keys = (shiftKey: boolean, ctrlKey = false, metaKey = false) => ({
    shiftKey,
    ctrlKey,
    metaKey,
  })

  it('holds what the last key event said, and lets go on blur', () => {
    const modifiers = trackModifiers()
    const shiftWheel = (): number =>
      horizontalRowWheel({ deltaX: 0, deltaY: 30, deltaMode: 0, ...modifiers.current() }, 800)
    expect(modifiers.current()).toEqual(keys(false))

    modifiers.update(keys(true))
    expect(modifiers.current()).toEqual(keys(true))
    expect(shiftWheel()).toBe(30)

    modifiers.update(keys(false))
    expect(modifiers.current()).toEqual(keys(false))

    modifiers.update(keys(true, true))
    modifiers.reset()
    expect(modifiers.current()).toEqual(keys(false))
    expect(shiftWheel()).toBe(0)
  })
})

describe('noticing a webview being mounted', () => {
  const added = (...names: string[]) => [{ addedNodes: names.map((nodeName) => ({ nodeName })) }]

  it('reacts to an inserted iframe and to nothing else', () => {
    expect(addsIframe(added('IFRAME'))).toBe(true)
    expect(addsIframe([...added('DIV', 'SPAN'), ...added('IFRAME')])).toBe(true)
    expect(addsIframe(added('DIV', '#text'))).toBe(false)
    expect(addsIframe([])).toBe(false)
  })
})
