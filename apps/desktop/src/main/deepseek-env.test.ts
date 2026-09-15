import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/chorus-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const { deepseekEnv, DEEPSEEK_MODELS } = await import('./runtime.js')

/**
 * The recipe, checked against DeepSeek's published one rather than against
 * memory.
 *
 * Nine variables, and this is the file that notices when one is dropped. Four
 * of them are model pins whose absence is not a crash but a bill: an aliased or
 * delegated model with no pin resolves through DeepSeek's `claude-opus` mapping
 * to `deepseek-v4-pro` and is charged at Pro rates.
 */
describe('the DeepSeek environment', () => {
  const env = deepseekEnv('sk-test')

  it('points at DeepSeek rather than Anthropic', () => {
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://api.deepseek.com/anthropic')
  })

  it('presents the key as a bearer token, not as an api key', () => {
    /*
     * `ANTHROPIC_AUTH_TOKEN`, never `ANTHROPIC_API_KEY`. The latter prompts for
     * approval once in an interactive CLI and is the variable a user is most
     * likely to already have set for their own Claude account.
     */
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('sk-test')
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('pins every model slot so nothing resolves to V4-Pro pricing', () => {
    expect(env['ANTHROPIC_MODEL']).toBe('deepseek-flash[1m]')
    expect(env['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('deepseek-flash[1m]')
    expect(env['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('deepseek-flash[1m]')
    expect(env['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('deepseek-flash')
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe('deepseek-flash')
  })

  it('names no Claude model anywhere', () => {
    // A `claude-*` name is mapped on DeepSeek's side, and an opus-shaped one is
    // mapped to the expensive model. None should ever be in this map.
    expect(Object.values(env).filter((v) => v.startsWith('claude-'))).toEqual([])
  })

  it('raises the compaction threshold to match the million-token context', () => {
    expect(env['CLAUDE_CODE_AUTO_COMPACT_WINDOW']).toBe('786432')
  })

  /*
   * The control. Every assertion above reads one key, so all of them would still
   * pass if a tenth variable were added or one were quietly renamed — the count
   * is the thing that catches a half-applied edit.
   */
  it('sets exactly the nine the recipe lists', () => {
    expect(Object.keys(env)).toHaveLength(9)
  })
})

/**
 * The picker's catalogue, stated rather than discovered.
 *
 * `supportedModels` asks the running CLI, which answers with the models Claude
 * Code knows about whatever provider it points at. For DeepSeek that is Opus and
 * Sonnet for an endpoint that has neither — so this list is written down, and
 * this is the file that notices when it stops matching DeepSeek's published one.
 */
describe('the DeepSeek model catalogue', () => {
  it('offers the three published names and nothing else', () => {
    expect(DEEPSEEK_MODELS.map((m) => m.value)).toEqual([
      'deepseek-flash[1m]',
      'deepseek-flash',
      'deepseek-v4-pro',
    ])
  })

  it('leads with the model a session gets when nobody chooses', () => {
    /*
     * "The provider's default" in the picker resolves to the injected
     * ANTHROPIC_MODEL, so the first entry here and that variable have to agree
     * or the top of the list would silently not be the default.
     */
    expect(DEEPSEEK_MODELS[0]?.value).toBe(deepseekEnv('sk-test')['ANTHROPIC_MODEL'])
  })

  it('names no Claude model', () => {
    // A `claude-*` value would be mapped on DeepSeek's side into something
    // nobody picked, and an opus-shaped one maps to the expensive route.
    expect(DEEPSEEK_MODELS.filter((m) => m.value.startsWith('claude-'))).toEqual([])
  })

  it('advertises no effort levels, because the recipe pins one', () => {
    // `CLAUDE_CODE_EFFORT_LEVEL=max` applies to all three, so an effort control
    // would be a lie rather than a choice.
    expect(DEEPSEEK_MODELS.filter((m) => (m.effortLevels?.length ?? 0) > 0)).toEqual([])
  })

  it('gives every entry a label that is not the raw id', () => {
    for (const model of DEEPSEEK_MODELS) {
      expect(model.label).not.toBe(model.value)
      expect(model.label.length).toBeGreaterThan(0)
    }
  })
})
