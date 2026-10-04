const MASKED = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
])

const MASK = '••••••••'

/**
 * Hides the value of a header that is a credential, and nothing else.
 *
 * **Display only, and the plan says so out loud.** The bytes are still in main
 * and still on the wire; this stops a shoulder or a screenshot from carrying a
 * live token away, and it is not a claim that the token is protected. The mask
 * is a fixed run rather than the value's length, because a length is a fact
 * about a secret that costs nothing to withhold.
 */
export const maskHeaders = (
  headers: readonly (readonly [string, string])[],
  reveal: boolean
): readonly (readonly [string, string])[] =>
  headers.map(([name, value]): readonly [string, string] =>
    !reveal && value !== '' && MASKED.has(name.toLowerCase()) ? [name, MASK] : [name, value]
  )
