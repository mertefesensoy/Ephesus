/**
 * Pure walk math for the Terraces floor (UI-DESIGN §5–§6).
 * Motion rules: 250 ms per tile, stepped easing (4–6 frames per tile — we use 5),
 * never smooth cubic. All functions are pure; the Pixi layer only renders
 * what these return, so the mechanism is unit-testable without a canvas.
 */
export const TILE_PX = 32
export const MS_PER_TILE = 250
export const STEPS_PER_TILE = 5

export interface Point {
  readonly x: number
  readonly y: number
}

export interface WalkPose {
  /** Position in pixels, quantized to the stepped easing grid. */
  readonly x: number
  readonly y: number
  /** 1 when walking toward +x, -1 toward -x (sprite flip). */
  readonly facing: 1 | -1
  /** Alternating gait frame (0|1), advancing once per easing step. */
  readonly frame: 0 | 1
  readonly done: boolean
}

/** Quantized progress in [0,1]: floor(p * steps) / steps — stepped, never smooth. */
export function steppedProgress(elapsedMs: number, durationMs: number, steps: number): number {
  if (durationMs <= 0 || steps <= 0) throw new Error('steppedProgress: non-positive duration/steps')
  const p = Math.min(Math.max(elapsedMs / durationMs, 0), 1)
  return Math.min(Math.floor(p * steps) / steps, 1)
}

/** Pose along a straight walk from `from` to `to` (pixel coords) after `elapsedMs`. */
export function walkPose(from: Point, to: Point, elapsedMs: number): WalkPose {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const tiles = Math.max(Math.abs(dx), Math.abs(dy)) / TILE_PX
  const durationMs = tiles * MS_PER_TILE
  const totalSteps = Math.max(1, Math.round(tiles * STEPS_PER_TILE))
  const progress = durationMs === 0 ? 1 : steppedProgress(elapsedMs, durationMs, totalSteps)
  const stepIndex = Math.round(progress * totalSteps)
  return {
    x: from.x + dx * progress,
    y: from.y + dy * progress,
    facing: dx < 0 ? -1 : 1,
    frame: (stepIndex % 2) as 0 | 1,
    done: progress >= 1
  }
}

/**
 * Endless patrol between two waypoints. Given total elapsed time, returns the
 * pose within the current leg (A→B or B→A). Pure: same input, same pose.
 */
export function patrolPose(a: Point, b: Point, elapsedMs: number): WalkPose {
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  const legMs = (Math.max(dx, dy) / TILE_PX) * MS_PER_TILE
  if (legMs === 0) return { x: a.x, y: a.y, facing: 1, frame: 0, done: true }
  const cycle = elapsedMs % (2 * legMs)
  return cycle < legMs ? walkPose(a, b, cycle) : walkPose(b, a, cycle - legMs)
}
