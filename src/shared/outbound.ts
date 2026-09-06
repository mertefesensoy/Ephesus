import { z } from 'zod'
import { AUTONOMY_RANK, type AutonomyLevel } from './gates'
import { repoRemoteSchema } from './harbor'

/**
 * Outbound public communication (FR-9.3, UC-10 step 3 — the Front Office).
 *
 * The M7.5 package line states the stake plainly: **"auto-post" is the first
 * outward-facing irreversible act the company can take on its own — that gate
 * belongs in the harness, not in a playbook's prose.** So the ladder from
 * draft-only to auto-post is decided by one total function here, and the
 * posting path physically cannot be reached without its answer.
 *
 * A comment is irreversible in the way that matters. It can be deleted, but by
 * then it has been read, mailed to every subscriber of the thread, and indexed.
 * There is no undo for having said something in public under the company's
 * name, which is why this is the one place in the codebase where the permission
 * is carried as an unforgeable value (`PostPermit`) rather than as a boolean a
 * caller could pass by mistake.
 *
 * The ladder maps onto the autonomy levels the Watch already has, on the
 * `outbound` gate kind the Architect added for it (2026-08-31 — see
 * `src/shared/gates.ts` for why it is a seventh kind rather than a borrowed
 * one):
 *
 * | level | UC-10's words | what happens |
 * |---|---|---|
 * | `manual` | draft-only | filed for the Architect; nothing is sent |
 * | `supervised` | above the configured level | held at a gate, batched into the standup |
 * | `autonomous` | auto-post | sent |
 */

export const OUTBOUND_SCHEMA_VERSION = 1

/** Where a comment can go. Both are `gh` subcommands the Harbor can run. */
export const OUTBOUND_TARGETS = ['issue', 'pull-request'] as const
export const outboundTargetSchema = z.enum(OUTBOUND_TARGETS)
export type OutboundTarget = z.infer<typeof outboundTargetSchema>

/**
 * A reply an agent wrote and wants sent.
 *
 * The body is the AGENT'S words and is never rewritten by the harness — the
 * same rule the incident summary follows. What the harness owns is whether the
 * words are sent, not what they say.
 */
export const outboundDraftSchema = z
  .object({
    schemaVersion: z.literal(OUTBOUND_SCHEMA_VERSION),
    kind: z.literal('outbound-draft'),
    repo: repoRemoteSchema,
    target: outboundTargetSchema,
    /** Issue or PR number the reply answers. */
    ref: z.number().int().positive().max(10_000_000),
    /**
     * The comment text. Capped generously: a reply longer than this is a
     * document, and a document belongs in the repository rather than in a
     * comment box.
     */
    body: z.string().min(1).max(20_000)
  })
  .strict()

export type OutboundDraft = z.infer<typeof outboundDraftSchema>

export type OutboundParse =
  | { readonly ok: true; readonly draft: OutboundDraft }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: parses an agent's draft, or lists everything wrong with it. Pure;
 * never throws.
 *
 * A malformed draft is refused rather than partially honoured. There is no
 * "post what we could read of it" path, for the obvious reason.
 */
export function parseOutboundDraft(body: string): OutboundParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `outbound draft: not JSON — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      ]
    }
  }
  const parsed = outboundDraftSchema.safeParse(raw)
  if (parsed.success) return { ok: true, draft: parsed.data }
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'outbound draft'
      return `${where}: ${issue.message}`
    })
  }
}

/** What the harness will do with a draft at a given autonomy level. */
export type OutboundDisposition =
  /** Draft-only. Filed for the Architect; nothing leaves the machine. */
  | { readonly kind: 'file'; readonly because: 'draft-only' }
  /** Held at an `outbound` gate; the standup carries it (UC-10 step 3). */
  | { readonly kind: 'hold'; readonly because: 'above-configured-level' }
  /** Sent. The only disposition that can produce a `PostPermit`. */
  | { readonly kind: 'post' }

/**
 * Contract: total and pure. Every autonomy level has exactly one disposition.
 *
 * Written as an exhaustive switch over the level rather than a comparison
 * against a threshold, so adding an autonomy level fails to compile here rather
 * than silently taking whichever branch a `>=` happened to put it in. For the
 * one act in this system that cannot be recalled, "the compiler asked" is worth
 * more than a clever inequality.
 */
export function dispositionFor(level: AutonomyLevel): OutboundDisposition {
  switch (level) {
    case 'manual':
      return { kind: 'file', because: 'draft-only' }
    case 'supervised':
      return { kind: 'hold', because: 'above-configured-level' }
    case 'autonomous':
      return { kind: 'post' }
  }
}

/**
 * Contract: true when `level` is at least as permissive as `atLeast`.
 *
 * Exists so callers compare levels through the shared rank rather than by
 * inventing an ordering — the same reason `composeAutonomy` exists.
 */
export function permits(level: AutonomyLevel, atLeast: AutonomyLevel): boolean {
  return AUTONOMY_RANK[level] >= AUTONOMY_RANK[atLeast]
}

/**
 * Permission to send one specific draft.
 *
 * **This is the mechanism the M7.5 risk line asks for.** The Harbor's post
 * path takes a `PostPermit` and nothing else will do: the type is branded, so
 * no caller can assemble one from a boolean, an options bag, or an object
 * literal that happens to have the right fields. The only two ways to obtain
 * one are `permitToPost` (which requires a disposition of `post`, i.e. an
 * `autonomous` level) and `permitFromApproval` (which requires a decided gate).
 *
 * A draft-only profile therefore has **no code path that posts** — not a path
 * guarded by an `if`, but no path at all, because nothing in that flow can
 * produce the value the poster requires. That is the S-SECRETS pattern applied
 * to an outbound act: the absence is structural and can be asserted on the API
 * surface rather than argued about.
 */
export interface PostPermit {
  /**
   * The brand. Type-only and unconstructible outside this module, following
   * `StationReason` in `src/shared/stations.ts` — the repo's existing idiom.
   */
  readonly __postPermit: unique symbol
  readonly draft: OutboundDraft
  /** How the permission was obtained, for the log (NFR-13). */
  readonly granted: 'autonomy' | 'architect-approval'
  /** The gate this permit answers, when it came from one. */
  readonly gateId: string | null
}

/**
 * Contract: a permit for a draft the profile's own autonomy already allows.
 * Returns null for every disposition that is not `post`.
 */
export function permitToPost(
  draft: OutboundDraft,
  disposition: OutboundDisposition
): PostPermit | null {
  if (disposition.kind !== 'post') return null
  return { draft, granted: 'autonomy', gateId: null } as unknown as PostPermit
}

/**
 * Contract: a permit for a draft an Architect approved at a gate. Returns null
 * unless the verdict actually approved it.
 *
 * `approved` is the decided gate's verdict, passed in rather than read here:
 * the Watch owns verdicts, and a second module that could decide one would be a
 * second place the answer lives.
 */
export function permitFromApproval(
  draft: OutboundDraft,
  gateId: string,
  approved: boolean
): PostPermit | null {
  if (!approved) return null
  return { draft, granted: 'architect-approval', gateId } as unknown as PostPermit
}

/** How a draft is named in the log and on a gate (NFR-13). */
export function outboundKey(draft: Pick<OutboundDraft, 'repo' | 'target' | 'ref'>): string {
  return `${draft.repo}#${draft.target}:${String(draft.ref)}`
}

/**
 * The Front Office's restart record (ADR-0030, extending ADR-0027).
 *
 * ## The defect this closes
 *
 * `gates.json` restores an `outbound` gate, and until this existed the DRAFT
 * that gate held did not come back with it — `FrontOffice.held` was memory
 * alone. The Architect saw a restored gate, read packaging that rendered
 * correctly, approved it, and `onVerdict` found nothing to post. The gate
 * settled as approved, the log recorded a verdict, and the comment never left
 * the machine. M8.8 made that reachable rather than causing it: before the
 * restore the queue came back empty and the gate could not be approved at all.
 *
 * ADR-0027's rule was right and its list was short by one — a filed draft is a
 * decision about an identity (these words, from this agent, held at this gate),
 * not an observation about a process, and nothing re-derives it.
 */
export const DRAFTS_REL = 'drafts.json'

const outboundDispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), because: z.literal('draft-only') }).strict(),
  z.object({ kind: z.literal('hold'), because: z.literal('above-configured-level') }).strict(),
  z.object({ kind: z.literal('post') }).strict()
])

/** One draft as it was filed: the words, who wrote them, and what was done. */
export const filedDraftSchema = z
  .object({
    key: z.string().min(1).max(256),
    draft: outboundDraftSchema,
    author: z.string().min(1).max(128),
    disposition: outboundDispositionSchema,
    /** The gate holding it, or null for a draft-only filing. */
    gateId: z.string().min(1).max(128).nullable(),
    /**
     * Still waiting for the Architect. Recorded rather than inferred from
     * `gateId`, because a decided draft keeps its gate id as history — and a
     * restore that re-held every draft with a gate id would put comments the
     * Architect already answered back into `pending()`, which is what the
     * standup reads.
     */
    awaiting: z.boolean(),
    at: z.string().min(1).max(64)
  })
  .strict()
  // `awaiting` and `gateId` are two fields describing one situation, so the
  // schema says how they relate rather than leaving the impossible pair
  // representable. A hold that could not open a gate is not waiting for
  // anyone — nobody was asked — and a record claiming otherwise would restore
  // a draft that no verdict can ever reach. `JsonStateStore.save` validates
  // before writing, so this refuses the write rather than the next boot.
  .refine(
    (filed) => !(filed.awaiting && filed.gateId === null),
    'a draft cannot await a gate it never got'
  )

/**
 * How many drafts the record keeps, oldest dropped first.
 *
 * Smaller than the settled-gate bound because each row carries a comment body
 * of up to 20,000 characters, so this file grows per row where that one does
 * not. **A draft still held at a gate is never dropped**, whatever the count —
 * dropping one is the defect this record exists to close, and the trim exists
 * only to stop the reviewed history growing without limit (the M8.10 class,
 * early). The schema's own bound is deliberately looser than the trim so that a
 * company holding an implausible number of unanswered gates still writes its
 * record rather than failing the save.
 */
export const DRAFT_RECORD_TRIM = 200

export const draftsRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    drafts: z.array(filedDraftSchema).max(1000)
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.drafts.filter((d) => d.gateId !== null).map((d) => d.gateId)).size ===
      value.drafts.filter((d) => d.gateId !== null).length,
    'two drafts held at one gate'
  )

export type DraftsRecord = z.infer<typeof draftsRecordSchema>
export const EMPTY_DRAFTS: DraftsRecord = { schemaVersion: 1, drafts: [] }
