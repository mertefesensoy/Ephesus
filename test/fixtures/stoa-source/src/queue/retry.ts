// PLANTED PATTERN 2: the backoff is bounded by a deadline rather than by an
// attempt count, so a slow dependency cannot extend a job indefinitely.
export function nextDelay(attempt: number, deadlineMs: number, nowMs: number): number {
  const backoff = Math.min(2 ** attempt * 100, 30_000)
  return Math.max(0, Math.min(backoff, deadlineMs - nowMs))
}
