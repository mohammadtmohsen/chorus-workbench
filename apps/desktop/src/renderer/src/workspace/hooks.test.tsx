/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useRaisedEditor } from './hooks.js'

interface Props {
  readonly projectId: string | null
  readonly covered: boolean
}

const setup = (initialProps: Props) =>
  renderHook((props: Props) => useRaisedEditor(props.projectId, props.covered), { initialProps })

const raise = (result: { current: readonly [boolean, () => void, () => void] }): void => {
  act(() => {
    result.current[1]()
  })
}

describe('useRaisedEditor', () => {
  it('clears the raised state once coverage ends, and stays lowered on the next cover', () => {
    const { result, rerender } = setup({ projectId: 'p1', covered: true })
    expect(result.current[0]).toBe(false)

    raise(result)
    expect(result.current[0]).toBe(true)

    rerender({ projectId: 'p1', covered: false })
    expect(result.current[0]).toBe(false)

    rerender({ projectId: 'p1', covered: true })
    expect(result.current[0]).toBe(false)
  })

  it('clears the raised state when the pane shows another project', () => {
    const { result, rerender } = setup({ projectId: 'p1', covered: true })
    raise(result)
    expect(result.current[0]).toBe(true)

    rerender({ projectId: 'p2', covered: true })
    expect(result.current[0]).toBe(false)
  })

  it('stays lowered after an uncover and a re-cover', () => {
    const { result, rerender } = setup({ projectId: 'p1', covered: true })
    raise(result)

    rerender({ projectId: 'p1', covered: false })
    rerender({ projectId: 'p1', covered: true })

    expect(result.current[0]).toBe(false)
  })

  it('does nothing when raised with no coverage', () => {
    const { result } = setup({ projectId: 'p1', covered: false })

    raise(result)

    expect(result.current[0]).toBe(false)
  })

  it('clears the raised state when lowered', () => {
    const { result } = setup({ projectId: 'p1', covered: true })
    raise(result)
    expect(result.current[0]).toBe(true)

    act(() => {
      result.current[2]()
    })

    expect(result.current[0]).toBe(false)
  })
})
