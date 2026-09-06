/**
 * Whether a renderer that just died may be brought back (2026-09-06).
 *
 * ## The defect this exists for
 *
 * The renderer process died and **nothing in the harness noticed**. There was
 * no `render-process-gone` handler anywhere in main, and `UiBridge` treats a
 * dead renderer exactly as it treats a closing one — deliberately, and on
 * reasoning that is right for the case it was written for: a window closing is
 * the normal end of a session, and saying so every time would be noise.
 *
 * A renderer that DIED is not a session ending. Observed live: three Electron
 * processes left (`main`, `gpu-process`, `utility`) and no renderer; twenty
 * engine processes still running; scheduled triggers still firing on the
 * minute; the Architect looking at a white window with no explanation anywhere.
 * The company keeps working, keeps spending, and keeps raising gates that need
 * a human — with the only surface that could answer them gone. That is
 * invariant §7 broken at the one place the Architect cannot route around.
 *
 * ## Why a bound, rather than "always relaunch"
 *
 * A renderer that dies because of what it loads will die again on reload, and
 * an unbounded relaunch turns one dead window into a spin that competes with
 * the agents for the machine. The ladder is the same shape M8.6 gave respawn:
 * try, and when trying is plainly not working, STOP and say so. A company with
 * no window is bad; a company with no window and a pegged CPU is worse.
 *
 * Contract: pure. Never throws, reads no clock of its own — the caller passes
 * `now`, so a test drives the deadline rather than waiting for it.
 */

/** How many deaths inside the window may still be answered with a relaunch. */
export const RENDERER_RELAUNCH_LIMIT = 3

/**
 * The window deaths are counted in.
 *
 * One minute, because the failure this bounds is a *loop* — load, die, reload,
 * die — which happens in seconds. A renderer that dies once an hour is not
 * looping, and each of those deaths deserves its own relaunch.
 */
export const RENDERER_RELAUNCH_WINDOW_MS = 60_000

export type RelaunchVerdict =
  | { readonly relaunch: true; readonly recent: number }
  | { readonly relaunch: false; readonly because: string; readonly recent: number }

/**
 * Contract: pure. `deathsAt` is every renderer death this session, oldest
 * first, INCLUDING the one being decided about — so the first death arrives as
 * a one-element array and is always answered with a relaunch.
 */
export function decideRelaunch(deathsAt: readonly number[], now: number): RelaunchVerdict {
  const recent = deathsAt.filter((at) => now - at < RENDERER_RELAUNCH_WINDOW_MS).length
  if (recent > RENDERER_RELAUNCH_LIMIT) {
    return {
      relaunch: false,
      recent,
      because:
        `the renderer died ${String(recent)} times in ` +
        `${String(Math.round(RENDERER_RELAUNCH_WINDOW_MS / 1000))}s; not relaunching again — ` +
        `the company is still running and can be seen by restarting the app`
    }
  }
  return { relaunch: true, recent }
}

/**
 * Contract: pure. The one-line detail for a death, from Electron's own reason.
 *
 * The reason is Electron's `details.reason` verbatim rather than a word of our
 * own, because it is the only thing that separates "out of memory" from "the
 * OS killed it" from "it crashed" — and those need different answers from the
 * Architect. `exitCode` rides along for the same reason: a report that cannot
 * be acted on is a report nobody reads twice.
 */
export function describeRendererDeath(reason: string, exitCode: number): string {
  return (
    `the window's renderer process is gone (${reason}, exit ${String(exitCode)}) — ` +
    `the company is still running headless, so agents keep working and any gate ` +
    `they raise has nobody to answer it until the window is back`
  )
}
