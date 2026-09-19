import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentRecord } from '@chorus/shared'
import { z } from 'zod'
import { normaliseExplainLanguage } from '../shared/ipc.js'

/**
 * What a new session starts with, remembered between launches.
 *
 * Deliberately not in the event log: the log records what happened in a
 * conversation, and a preference is neither an event nor something you would
 * want replayed. A small JSON file is the honest shape for it.
 *
 * Everything here is a *default*, never a constraint — each session still
 * chooses its own agents, directory and profile when it starts. That is what
 * keeps this file safe to lose.
 *
 * Zoom is deliberately **not** here. It is a per-launch adjustment, not a
 * preference: the app opens at 100% every time, and a size you set to read one
 * long diff should not be waiting for you tomorrow. An older file may still
 * carry a `scale` key; the schema drops it on the next read.
 */

/**
 * One value per agent, defaulting to "the provider decides".
 *
 * Empty is a real answer and not a missing one: a model nobody chose is the
 * provider's own default, which is the right thing for a machine whose CLI we
 * have not asked yet.
 */
const perAgent = z.object(agentRecord(() => z.string().default(''))).default(agentRecord(() => ''))

export const Settings = z
  .object({
    /*
     * `agents` stood here and is gone, and unlike `model` below it is not kept
     * for migration.
     *
     * The two cases are opposite. `model` is read and folded onto Claude, so
     * dropping it would lose a value its owner chose. `agents` decided a cast,
     * and a cast is no longer a choice anybody makes — the value is not being
     * migrated anywhere, it has simply stopped meaning anything. zod strips what
     * it does not name, so an existing file loses the key on its next save,
     * which is the outcome we want rather than one to guard against.
     */
    /** Empty means "start at home", the same as leaving the field blank. */
    cwd: z.string(),
    profileId: z.string(),
    /**
     * The shape before models were per agent. Read, migrated, and then written
     * back empty — see the transform below.
     *
     * Kept in the schema rather than deleted because zod strips what it does not
     * name, and a settings file written by 0.8.1 would otherwise lose the model
     * its owner had chosen on the first read after upgrading.
     */
    model: z.string().default(''),
    effortLevel: z.string().default(''),
    /**
     * What a new session's agents start as, per agent. Empty means the provider's
     * own choice, which is not the same as a named model and must stay
     * expressible.
     *
     * Per agent because the two providers share no model. One value for both was
     * not a simplification — it sent a name from one catalogue to the other's API.
     */
    models: perAgent,
    /**
     * Likewise reasoning effort, and per agent for a sharper reason: Codex's
     * levels differ *per model* — `ultra` exists on some and not others — so even
     * the levels the two providers appear to share are not interchangeable.
     */
    efforts: perAgent,
    /**
     * The language a passage is explained in, when someone asks for one.
     *
     * Empty is the default and means the action is not offered at all. There is no
     * honest guess at a person's own language — the system locale describes the
     * machine, not whoever is reading — and a wrong guess here produces an answer
     * in a language nobody asked for.
     *
     * Normalised through the same function the renderer's field uses, so a
     * hand-edited file with a newline in it is tidied on read rather than
     * producing a control that looks empty while holding content.
     */
    explainLanguage: z.string().default('').transform(normaliseExplainLanguage),
    /**
     * Whether a new conversation starts in the bilingual style.
     *
     * Must track `SettingsShape` in `shared/ipc.ts`, like every other key here.
     *
     * A default and nothing more — the live value belongs to the conversation, so
     * one room can read Arabic while the room next door is answering a colleague
     * in English. What the style *is* lives in code as
     * `DEFAULT_STYLE_INSTRUCTION`; there is deliberately no setting for it.
     */
    styleOnByDefault: z.boolean().default(false),
    /**
     * Which appearance to draw, rather than always deferring to the OS.
     *
     * `system` is the default and preserves what every version before this did:
     * follow `prefers-color-scheme`. The other two override it, which VS Code
     * users expect to be able to do — until now light mode here was a media
     * query with no switch attached.
     *
     * **Global, not per conversation.** It lived in `ChangesPanelState` in the
     * first draft of the plan, which is per-conversation state — one session in
     * dark and the next in light is not a feature.
     *
     * `.default(...)` is load-bearing: a required field here would fail the
     * parse for every settings file written before this shipped, and
     * `readSettings` falls back to defaults on a parse failure — so every
     * existing preference on the machine would silently reset.
     */
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    completionProvider: z.enum(['auto', 'deepseek', 'codestral']).default('auto'),
  })
  /**
   * Folds the old single model and effort onto **Claude**.
   *
   * Not a split. Whatever is in a settings file today was chosen from Claude's
   * list, because that is the only catalogue the sheet has ever shown — so the
   * honest migration is to recognise whose it was, and let Codex start with the
   * provider default rather than inheriting a name its API does not know.
   *
   * A transform rather than a migration step someone has to remember to run, and
   * it clears the legacy fields as it goes so the fold happens exactly once.
   */
  .transform((raw) => {
    const models = { ...raw.models }
    const efforts = { ...raw.efforts }
    if (raw.model !== '' && models.claude === '') models.claude = raw.model
    if (raw.effortLevel !== '' && efforts.claude === '') efforts.claude = raw.effortLevel
    return { ...raw, model: '', effortLevel: '', models, efforts }
  })
export type Settings = z.infer<typeof Settings>

export const DEFAULT_SETTINGS: Settings = {
  cwd: '',
  // Permissive defaults ship by accident, not on purpose (plan §4.4).
  profileId: 'read-only',
  // Nothing chosen: the provider decides, which is the right default for a
  // machine whose CLI we have not asked yet.
  model: '',
  effortLevel: '',
  // Off until someone says which language. See the field's own comment.
  explainLanguage: '',
  // Off: a first launch answers exactly as every launch before this existed.
  styleOnByDefault: false,
  models: agentRecord(() => ''),
  efforts: agentRecord(() => ''),
  // Follow the OS, which is what every version before the setting existed did.
  theme: 'system',
  // Off: a first launch answers exactly as every launch before this existed.
  completionProvider: 'auto',
}

function settingsPath(userDataPath: string): string {
  return join(userDataPath, 'settings.json')
}

/**
 * Reads the file, falling back to defaults on anything unexpected.
 *
 * A corrupt or hand-edited settings file must not stop the app opening — the
 * worst case is a preference reset, and refusing to launch over one is a far
 * bigger failure than the one it reports.
 */
export function readSettings(userDataPath: string): Settings {
  try {
    const parsed = Settings.safeParse(JSON.parse(readFileSync(settingsPath(userDataPath), 'utf8')))
    return parsed.success ? parsed.data : DEFAULT_SETTINGS
  } catch {
    // Missing is the common case, and it is not an error.
    return DEFAULT_SETTINGS
  }
}

/**
 * Writes via a temporary file and a rename, so a crash mid-write cannot leave a
 * half-written file where a valid one used to be. Rename is atomic within a
 * directory on every filesystem this app runs on.
 */
export function writeSettings(userDataPath: string, next: Settings): Settings {
  const settings = Settings.parse(next)
  mkdirSync(userDataPath, { recursive: true })
  const target = settingsPath(userDataPath)
  const temp = `${target}.tmp`
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
  return settings
}
