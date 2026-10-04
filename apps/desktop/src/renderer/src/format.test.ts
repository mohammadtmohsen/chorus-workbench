import { afterEach, describe, expect, it, vi } from 'vitest'
import { clockTime, compactTokens, money, untilReset } from './format.js'

describe('compactTokens', () => {
  it('leaves small counts exact', () => {
    expect(compactTokens(0)).toBe('0')
    expect(compactTokens(999)).toBe('999')
  })

  it('uses thousands, with a decimal only while it says something', () => {
    expect(compactTokens(1_200)).toBe('1.2k')
    expect(compactTokens(34_500)).toBe('35k')
  })

  it('uses millions past a million', () => {
    expect(compactTokens(3_400_000)).toBe('3.4M')
  })
})

describe('money', () => {
  it('does not round a real amount away to nothing', () => {
    // Most turns cost fractions of a cent; "$0.00" would read as free.
    expect(money(0.004)).toBe('<$0.01')
  })

  it('shows cents below a hundred dollars', () => {
    expect(money(0.42)).toBe('$0.42')
    expect(money(12.5)).toBe('$12.50')
  })

  it('drops cents once they are noise', () => {
    expect(money(1234.56)).toBe('$1,235')
  })

  it('says nothing spent plainly', () => {
    expect(money(0)).toBe('$0')
  })
})

describe('untilReset', () => {
  const now = 1_700_000_000_000

  it('says now once the window has passed', () => {
    expect(untilReset(now - 1, now)).toBe('now')
  })

  it('counts minutes under an hour', () => {
    expect(untilReset(now + 25 * 60_000, now)).toBe('25m')
    // Never "0m": something still to wait for should not read as none.
    expect(untilReset(now + 20_000, now)).toBe('1m')
  })

  it('counts hours and minutes under a day', () => {
    expect(untilReset(now + 2 * 3_600_000, now)).toBe('2h')
    expect(untilReset(now + (2 * 60 + 14) * 60_000, now)).toBe('2h 14m')
  })

  it('counts days past one', () => {
    expect(untilReset(now + 3 * 86_400_000, now)).toBe('3d')
    expect(untilReset(now + 26 * 3_600_000, now)).toBe('1d 2h')
  })
})

describe('clockTime', () => {
  // A fixed instant, and an explicit locale: the machine's own would make this
  // assert whatever CI is set to rather than what the function does.
  const at = new Date(2026, 7, 13, 9, 14).getTime()

  it('writes a twelve-hour clock the way en-US reads one', () => {
    expect(clockTime(at, 'en-US')).toMatch(/^9:14\s?AM$/)
  })

  it('writes the same instant on a twenty-four-hour clock elsewhere', () => {
    // No leading zero on the hour: `numeric` is what the approved composition
    // shows (`9:14 AM`), and `2-digit` would read as a duration.
    expect(clockTime(at, 'en-GB')).toBe('9:14')
  })

  it('pads the minute, which is the whole reason for 2-digit', () => {
    expect(clockTime(new Date(2026, 7, 13, 9, 4).getTime(), 'en-GB')).toBe('9:04')
  })
})

describe('clockTime formatter reuse', () => {
  const NativeDateTimeFormat = Intl.DateTimeFormat
  const spyOnConstruction = () =>
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args) {
      return new NativeDateTimeFormat(...args)
    })
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const at = new Date(2026, 7, 13, 9, 14).getTime()
  const times = [at, at + 60_000, at + 3_600_000, at + 7_260_000]
  const native = (locale: string | undefined, time: number): string =>
    new Intl.DateTimeFormat(locale, options).format(new Date(time))
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds one formatter for a run of timestamps, matching a fresh one', async () => {
    const expected = times.map((time) => native('en-US', time))
    await settle()
    const construct = spyOnConstruction()
    expect(times.map((time) => clockTime(time, 'en-US'))).toEqual(expected)
    expect(construct).toHaveBeenCalledTimes(1)
  })

  it('keeps each locale, and the default locale, apart', async () => {
    const expected = [native('en-US', at), native('en-GB', at), native(undefined, at)]
    await settle()
    const construct = spyOnConstruction()
    const first = [clockTime(at, 'en-US'), clockTime(at, 'en-GB'), clockTime(at)]
    const again = [clockTime(at, 'en-US'), clockTime(at, 'en-GB'), clockTime(at)]
    expect(first).toEqual(expected)
    expect(again).toEqual(expected)
    expect(construct.mock.calls.map(([locale]) => locale)).toEqual(['en-US', 'en-GB', undefined])
  })

  it('builds a fresh formatter once the batch has ended', async () => {
    await settle()
    const construct = spyOnConstruction()
    clockTime(at, 'en-GB')
    clockTime(at, 'en-GB')
    expect(construct).toHaveBeenCalledTimes(1)
    await settle()
    expect(clockTime(at, 'en-GB')).toBe('9:14')
    expect(construct).toHaveBeenCalledTimes(2)
  })

  it('still refuses an invalid locale, without keeping anything for it', async () => {
    await settle()
    const construct = spyOnConstruction()
    expect(() => clockTime(at, '')).toThrow(RangeError)
    expect(() => clockTime(at, '')).toThrow(RangeError)
    expect(construct).toHaveBeenCalledTimes(2)
    expect(clockTime(at, 'en-GB')).toBe('9:14')
    expect(construct).toHaveBeenCalledTimes(3)
  })
})
