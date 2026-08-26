import { z } from 'zod'

/** Persisted window bounds (SQLite `window_state`, SDD §4.6). */
export const windowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(400).max(20000),
    height: z.number().int().min(300).max(20000)
  })
  .strict()

export type WindowBounds = z.infer<typeof windowBoundsSchema>

export interface DisplayArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Returns bounds safe to restore, or null to fall back to defaults.
 * Contract: pure. Rejects malformed rows (schema) and windows whose top-left
 * would land outside every available display work area (e.g. a monitor that
 * was unplugged since last run) — restoring those would strand the window.
 */
export function sanitizeBounds(
  raw: unknown,
  displays: readonly DisplayArea[]
): WindowBounds | null {
  const parsed = windowBoundsSchema.safeParse(raw)
  if (!parsed.success) return null
  const b = parsed.data
  const visible = displays.some(
    (d) =>
      b.x >= d.x - b.width + 100 &&
      b.x <= d.x + d.width - 100 &&
      b.y >= d.y &&
      b.y <= d.y + d.height - 100
  )
  return visible ? b : null
}
