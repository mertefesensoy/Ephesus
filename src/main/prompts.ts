import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'

/**
 * The prompt store (SDD §1.1 `config.ts` text assets, SDD §2 `~/.ephesus/prompts/`).
 *
 * Invariant §8 — *prompt text is config*: no LLM-facing prose lives in code, so
 * every template is a file the Architect can edit without a rebuild. That only
 * works if the editable copy is the one actually read, which is why lookups go
 * to the harness home first and the bundled copy is merely the seed.
 *
 * Contract: `read()` returns the home copy; on first use it seeds that copy from
 * the bundled default and returns it. If neither exists it throws with both
 * paths — a missing prompt is a broken install, not something to paper over with
 * an inline string.
 */
export class PromptStore {
  /**
   * @param homePromptsDir `<harness home>/prompts` — the editable copy.
   * @param bundledPromptsDir the repo/app `prompts/` directory — the seed.
   */
  constructor(
    private readonly homePromptsDir: string,
    private readonly bundledPromptsDir: string
  ) {}

  /** Absolute path of the editable copy for a prompt, whether or not it exists. */
  pathOf(relPath: string): string {
    return path.join(this.homePromptsDir, relPath)
  }

  read(relPath: string): string {
    const homePath = this.pathOf(relPath)
    if (fs.existsSync(homePath)) return fs.readFileSync(homePath, 'utf8')

    const bundledPath = path.join(this.bundledPromptsDir, relPath)
    if (!fs.existsSync(bundledPath)) {
      throw new Error(`prompts: "${relPath}" missing from both ${homePath} and ${bundledPath}`)
    }
    const text = fs.readFileSync(bundledPath, 'utf8')
    fs.mkdirSync(path.dirname(homePath), { recursive: true })
    writeFileAtomic(homePath, text)
    return text
  }

  /**
   * Fills `{{name}}` placeholders. Contract: throws on a placeholder with no
   * value rather than sending `{{identity}}` to a language model — a silently
   * unfilled slot is exactly the kind of quiet failure invariant §7 forbids.
   */
  render(relPath: string, vars: Readonly<Record<string, string>>): string {
    const template = this.read(relPath)
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
      const value = vars[name]
      if (value === undefined) {
        throw new Error(`prompts: "${relPath}" needs a value for {{${name}}}`)
      }
      return value
    })
  }
}
