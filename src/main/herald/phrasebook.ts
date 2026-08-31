import type { PromptStore } from '../prompts'

/**
 * The Herald's phrase book — invariant §8, "prompt text is config".
 *
 * The policy layer emits KEYS (`switching-provider`, `voice-unavailable`); this
 * turns a key into the sentence the Architect actually hears. The split is the
 * whole point: the safety decision and the wording are different things, and
 * only one of them belongs in code. An Architect who wants the Herald to say
 * something else edits `prompts/herald/phrasebook.md` and does not rebuild.
 *
 * Format is the repo's existing one — a markdown file, `## key` headings, the
 * line beneath each. No new file format, no parser worth the name.
 */

export const PHRASEBOOK_PATH = 'herald/phrasebook.md'
export const PERSONA_PATH = 'herald/persona.md'
export const VOICE_ID_PATH = 'herald/voice-id.md'
export const TTS_MODEL_PATH = 'herald/model-id.md'
export const STT_MODEL_PATH = 'herald/stt-model-id.md'
export const REALTIME_MODEL_PATH = 'herald/realtime-model-id.md'

/** Contract: every `## key` section of a phrase book, trimmed. */
export function parsePhrasebook(text: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {}
  let key: string | null = null
  let buffer: string[] = []
  const flush = (): void => {
    if (key !== null) entries[key] = buffer.join('\n').trim()
    buffer = []
  }
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(line)
    if (heading?.[1]) {
      flush()
      key = heading[1]
      continue
    }
    if (key !== null) buffer.push(line)
  }
  flush()
  return entries
}

export class Phrasebook {
  constructor(private readonly prompts: PromptStore) {}

  /**
   * Contract: the line for a key, with `{{placeholders}}` filled.
   *
   * Throws on an unknown key rather than returning the key itself. A key
   * leaking into speech would have the Herald say "switching-provider" out
   * loud, which is worse than the crash: it looks like working software.
   */
  line(key: string, vars: Readonly<Record<string, string>> = {}): string {
    const entries = parsePhrasebook(this.prompts.read(PHRASEBOOK_PATH))
    const template = entries[key]
    if (template === undefined) {
      throw new Error(`herald: phrase book has no entry for "${key}"`)
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = vars[name]
      if (value === undefined) {
        throw new Error(`herald: phrase "${key}" needs a value for {{${name}}}`)
      }
      return value
    })
  }

  /** Contract: the persona text, for the provider's style prompt (FR-8.5). */
  persona(): string {
    return this.prompts.read(PERSONA_PATH).trim()
  }

  /** Contract: a single-value config file, trimmed — voice id, model id. */
  value(relPath: string): string {
    return this.prompts.read(relPath).trim()
  }
}
