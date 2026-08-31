import { VOICE_PROVIDERS, type VoiceFault, type VoiceProviderId } from './seam'

/**
 * The Herald's conversation policy — SDD §8, ADR-0007, VOICE-DESIGN §2–§3.
 *
 * ADR-0007's consequence names this file's job exactly: *"The policy layer is
 * where all safety-relevant voice behavior lives (repeat-back for destructive
 * approvals, FR-8.4) — provider adapters stay dumb pipes."* So four things live
 * here and nowhere else:
 *
 * 1. **Push-to-talk is always available**; the wake word is optional and off by
 *    default (VOICE-DESIGN §2, NFR-10 — no audio leaves the machine while idle).
 * 2. **Barge-in is absolute**: Architect speech stops TTS within 250 ms
 *    whatever the provider, and the unspoken remainder stays in the transcript.
 * 3. **Repeat-back** for destructive and spend approvals: a bare "yes" is
 *    rejected (FR-8.4). The policy decides whether one is required and what
 *    token must be spoken; the SENTENCE comes from `prompts/herald/` because
 *    the Herald's words are config (invariant §8).
 * 4. **Failover is the policy's decision.** Adapters classify faults; this
 *    reducer decides healthy → degraded → cooldown. Failback is manual
 *    (ADR-0007), so nothing here ever climbs back on its own.
 *
 * Everything is pure. Voice is the one modality where a wrong decision spends
 * money or deletes a branch, so the rules are values a table test can exhaust
 * rather than behaviour distributed through a session object.
 */

// ── Modes (FR-8.3, VOICE-DESIGN §2) ─────────────────────────────────────────

export const VOICE_MODES = ['push-to-talk', 'wake-word'] as const

export type VoiceMode = (typeof VOICE_MODES)[number]

/**
 * Contract: which activation modes are available. Push-to-talk is ALWAYS in the
 * list — FR-8.3 calls it "always", and a build that could turn it off would
 * leave the Architect with a wake word as the only way in.
 */
export function activeModes(opts: { readonly wakeWordEnabled: boolean }): readonly VoiceMode[] {
  return opts.wakeWordEnabled ? ['push-to-talk', 'wake-word'] : ['push-to-talk']
}

// ── Barge-in (NFR-3, VOICE-DESIGN §2) ───────────────────────────────────────

/** NFR-3 / VOICE-DESIGN §2: Architect speech stops TTS within 250 ms. */
export const BARGE_IN_MS = 250

export interface BargeIn {
  /** Whether playback must stop. */
  readonly stop: boolean
  /** The deadline the adapter's cancel has to beat, in ms from the trigger. */
  readonly withinMs: number
  /**
   * What the transcript records. VOICE-DESIGN §2: the interrupted text remains,
   * "marked 'unspoken from here'" — the Herald having started a sentence is a
   * fact about the session, and deleting it would lose what the Architect
   * heard.
   */
  readonly spoken: string
  readonly unspoken: string
}

/**
 * Contract: what happens when the Architect speaks over the Herald.
 *
 * Unconditional. There is no "unless it is important", no incident override —
 * VOICE-DESIGN §2 says "The Herald never talks over the Architect, ever", and
 * an exception here is the one place that promise could quietly acquire one.
 */
export function bargeIn(full: string, spokenSoFar: string): BargeIn {
  const spoken = full.startsWith(spokenSoFar) ? spokenSoFar : ''
  return {
    stop: true,
    withinMs: BARGE_IN_MS,
    spoken,
    unspoken: full.slice(spoken.length)
  }
}

// ── Repeat-back (FR-8.4, VOICE-DESIGN §3) ───────────────────────────────────

/**
 * Gate kinds whose voice approval needs an explicit repeat-back. `destructive`
 * is unconditional in `shared/gates.ts`; `spend` joins it because FR-8.4 names
 * both ("Destructive/spend approvals by voice SHALL require an explicit
 * repeat-back confirmation").
 */
export const REPEAT_BACK_KINDS = ['destructive', 'spend'] as const

/** Contract: whether a voice approval of this gate kind needs a repeat-back. */
export function needsRepeatBack(gateKind: string): boolean {
  return (REPEAT_BACK_KINDS as readonly string[]).includes(gateKind)
}

/** Bare assents FR-8.4 rejects — "a bare 'yes' is rejected". */
const BARE_ASSENTS = ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go ahead', 'do it', 'confirm']

/** Normalizes spoken or written text to the form tokens are compared in. */
function spokenForm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Contract: the exact token the Architect must speak, derived from the gate.
 *
 * A token, not a sentence: the SENTENCE that asks for it lives in
 * `prompts/herald/repeat-back.md` (invariant §8 — the Herald's words are
 * config). What this function owns is the safety property, which is that the
 * token identifies THIS gate and no other. "confirm" alone would be a bare
 * assent with extra steps.
 *
 * The token carries the gate's WHOLE subject. It used to carry the first three
 * words, which read as faithful to FR-8.4's example ("say confirm delete") and
 * was not: `delete branch release/9` and `delete branch release/10` produced one
 * token, and every spend gate collapsed to `confirm raise the daily` — so the
 * amount, which IS the subject of a spend approval, was absent from the words
 * confirming it. The M6 close-out audit found both by execution. FR-8.4's
 * example was amended with this change.
 */
export function repeatBackToken(gate: { readonly kind: string; readonly what: string }): string {
  const subject = spokenForm(gate.what)
  return `confirm ${subject || gate.kind}`.trim()
}

/** How long an issued repeat-back stays answerable (FR-8.4). */
export const REPEAT_BACK_TTL_MS = 120_000

/**
 * An issued repeat-back: the words to say, and the identity of THIS asking.
 *
 * The nonce is never spoken — a spoken nonce would make the Architect read
 * digits aloud to approve a gate. It exists so the harness can tell one asking
 * from the next: answering is single-use, and the same correct words cannot
 * approve the same gate twice or answer an asking that has already lapsed.
 */
export interface RepeatBackChallenge {
  readonly token: string
  readonly nonce: string
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}

/** Contract: issue a repeat-back for a gate. Pure — clock and nonce injected. */
export function repeatBackChallenge(
  gate: { readonly kind: string; readonly what: string },
  nowMs: number,
  nonce: string
): RepeatBackChallenge {
  return {
    token: repeatBackToken(gate),
    nonce,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + REPEAT_BACK_TTL_MS
  }
}

export type RepeatBackRefusal = 'bare-assent' | 'mismatch' | 'empty' | 'expired' | 'replayed'

export type RepeatBackCheck =
  | { readonly confirmed: true; readonly nonce: string }
  | { readonly confirmed: false; readonly because: RepeatBackRefusal }

/**
 * Contract: whether what the Architect said answers THIS repeat-back.
 *
 * Refusing a bare assent explicitly (rather than just failing to match) is the
 * point of FR-8.4: the Architect saying "yes" to a destructive gate is the
 * exact input the clause exists to reject, and the refusal reason has to say so
 * or the Herald cannot explain itself.
 *
 * The match is EXACT after normalization. It used to accept the token anywhere
 * inside a longer sentence, so that "confirm delete branch, please" would pass
 * — a defensible courtesy that also meant **"no, do not confirm delete branch
 * release 9" approved the gate**, because the refusal contains the token. The
 * M6 close-out audit proved that by running it. A confirmation the Architect
 * can give by accident, while saying the opposite, is not a confirmation; the
 * cost is that a trailing "please" now fails, which is the correct side to err
 * on for the only spoken act that cannot be undone.
 *
 * `spent` holds the nonces already used. Passing it is what makes answering
 * single-use rather than merely intended to be.
 */
export function checkRepeatBack(
  spoken: string,
  challenge: RepeatBackChallenge,
  nowMs: number,
  spent: ReadonlySet<string> = new Set()
): RepeatBackCheck {
  const said = spokenForm(spoken)
  if (said === '') return { confirmed: false, because: 'empty' }
  if (BARE_ASSENTS.includes(said)) return { confirmed: false, because: 'bare-assent' }
  if (nowMs >= challenge.expiresAtMs) return { confirmed: false, because: 'expired' }
  if (spent.has(challenge.nonce)) return { confirmed: false, because: 'replayed' }
  const wanted = spokenForm(challenge.token)
  return said === wanted
    ? { confirmed: true, nonce: challenge.nonce }
    : { confirmed: false, because: 'mismatch' }
}

// ── Failover (ADR-0007, FR-8.2, NFR-3) ──────────────────────────────────────

export const FAILOVER_STATES = ['healthy', 'degraded', 'cooldown'] as const

export type FailoverState = (typeof FAILOVER_STATES)[number]

/** NFR-3: the switch completes mid-session within 3 s. */
export const FAILOVER_BUDGET_MS = 3_000

export interface FailoverSnapshot {
  readonly state: FailoverState
  /** The provider carrying the session, or null in cooldown (text-only). */
  readonly provider: VoiceProviderId | null
  /** Providers this session has burned; a burned provider is not retried. */
  readonly burned: readonly VoiceProviderId[]
  /** Why the last transition happened. */
  readonly reason: VoiceFault | null
  /**
   * The one-line notice FR-8.2 requires, or null when nothing changed. The
   * TEXT of the notice is a phrase-book key, not a sentence: invariant §8
   * keeps the Herald's words in `prompts/herald/`.
   */
  readonly notice: string | null
  readonly sinceMs: number
}

export type FailoverEvent =
  /** An adapter classified a fault. It reports; this reducer decides. */
  | { readonly kind: 'fault'; readonly provider: VoiceProviderId; readonly fault: VoiceFault }
  /** The Architect asked to go back to the primary. Failback is manual only. */
  | { readonly kind: 'failback' }

/**
 * The order providers are tried in: ElevenLabs first (ADR-0007's reference
 * implementation, chosen for voice quality), OpenAI Realtime as the fallback.
 */
export const PROVIDER_ORDER: readonly VoiceProviderId[] = VOICE_PROVIDERS

export function initialFailover(
  nowMs: number,
  available: readonly VoiceProviderId[] = PROVIDER_ORDER
): FailoverSnapshot {
  const first = PROVIDER_ORDER.find((p) => available.includes(p)) ?? null
  return {
    state: first ? 'healthy' : 'cooldown',
    provider: first,
    burned: [],
    reason: null,
    notice: null,
    sinceMs: nowMs
  }
}

/**
 * Contract: pure. Applies one event and returns the next snapshot, or the SAME
 * object when the event changes nothing — so a caller can detect a no-op by
 * identity, the way `reduceAvatar` works.
 *
 * The machine is deliberately one-way. ADR-0007: "Failback is manual." A fault
 * burns its provider for the session; nothing recovers on a timer, because a
 * provider that failed auth will fail it again and a provider that breached
 * latency once will do it under the same load. `cooldown` is the honest end
 * state: no provider left, voice is off, and FR-8.6 says the rest of the system
 * carries on in text.
 */
export function reduceFailover(
  snapshot: FailoverSnapshot,
  event: FailoverEvent,
  nowMs: number,
  available: readonly VoiceProviderId[] = PROVIDER_ORDER
): FailoverSnapshot {
  if (event.kind === 'failback') {
    // Manual failback returns to the best available provider and clears the
    // burn list — the Architect is asserting the outage is over.
    const first = PROVIDER_ORDER.find((p) => available.includes(p)) ?? null
    if (!first || (snapshot.state === 'healthy' && snapshot.provider === first)) return snapshot
    return {
      state: 'healthy',
      provider: first,
      burned: [],
      reason: null,
      notice: 'failback',
      sinceMs: nowMs
    }
  }

  // A fault from a provider that is not carrying the session is stale — it
  // arrived after we had already moved on, and acting on it would burn the
  // provider we just switched TO.
  if (event.provider !== snapshot.provider) return snapshot

  const burned = [...snapshot.burned, event.provider]
  const next = PROVIDER_ORDER.find((p) => available.includes(p) && !burned.includes(p)) ?? null
  if (!next) {
    return {
      state: 'cooldown',
      provider: null,
      burned,
      reason: event.fault,
      // FR-8.6: both down is a VISIBLE text-only degradation, never silence.
      notice: 'voice-unavailable',
      sinceMs: nowMs
    }
  }
  return {
    state: 'degraded',
    provider: next,
    burned,
    reason: event.fault,
    // FR-8.2's one-line notice: "switching voice provider".
    notice: 'switching-provider',
    sinceMs: nowMs
  }
}

/** Contract: whether voice is available at all — the FR-8.6 degradation test. */
export function voiceAvailable(snapshot: FailoverSnapshot): boolean {
  return snapshot.provider !== null
}
