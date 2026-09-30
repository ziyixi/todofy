/**
 * Swipe physics of the deck card (docs/ux.md §3), as pure functions so the thresholds are unit-tested and
 * the component only wires pointer events to them.
 */
import type { Decision } from '../../../worker/src/api-types.ts'

/** Movement before a drag starts, and the axis must be clearly horizontal (direction lock). */
export const DRAG_START_PX = 8
/** Commit distance: 30 % of the card width, clamped. */
export const THRESHOLD_RATIO = 0.3
export const THRESHOLD_MIN_PX = 96
export const THRESHOLD_MAX_PX = 160
/** A flick commits below the distance threshold when fast enough and past this distance. */
export const FLICK_VELOCITY = 0.5
export const FLICK_MIN_PX = 40
export const MAX_TILT_DEG = 12
/** Vertical drag is damped so the card mostly slides sideways. */
export const VERTICAL_DAMPING = 0.15
export const SPRING_BACK_MS = 220
export const EXIT_MIN_MS = 200
export const EXIT_MAX_MS = 280
/** Pointer samples older than this do not count for the release velocity. */
export const VELOCITY_WINDOW_MS = 100

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function swipeThreshold(cardWidth: number): number {
  return clamp(cardWidth * THRESHOLD_RATIO, THRESHOLD_MIN_PX, THRESHOLD_MAX_PX)
}

/** `x` once the drag is clearly horizontal, `y` once it is clearly a scroll, null while undecided. */
export function lockAxis(dx: number, dy: number): 'x' | 'y' | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < DRAG_START_PX) return null
  return ax > ay ? 'x' : 'y'
}

export function directionOf(dx: number): Decision {
  return dx >= 0 ? 'like' : 'dislike'
}

/**
 * Whether a released drag commits: far enough, or a flick (fast, past FLICK_MIN_PX, same direction as the
 * displacement). Null springs back.
 */
export function releaseDecision(dx: number, velocityX: number, cardWidth: number): Decision | null {
  if (Math.abs(dx) >= swipeThreshold(cardWidth)) return directionOf(dx)
  const sameDirection = Math.sign(velocityX) === Math.sign(dx) && dx !== 0
  if (sameDirection && Math.abs(velocityX) >= FLICK_VELOCITY && Math.abs(dx) >= FLICK_MIN_PX) return directionOf(dx)
  return null
}

export interface CardPose {
  readonly x: number
  readonly y: number
  readonly rotate: number
}

/** The card's pose while dragging; no tilt under reduced motion. */
export function dragPose(dx: number, dy: number, cardWidth: number, reducedMotion: boolean): CardPose {
  const width = cardWidth > 0 ? cardWidth : 360
  const rotate = reducedMotion ? 0 : clamp((dx / width) * MAX_TILT_DEG, -MAX_TILT_DEG, MAX_TILT_DEG)
  return { x: dx, y: dy * VERTICAL_DAMPING, rotate }
}

export function poseTransform(pose: CardPose): string {
  return `translate3d(${pose.x.toFixed(1)}px, ${pose.y.toFixed(1)}px, 0) rotate(${pose.rotate.toFixed(2)}deg)`
}

/** Opacity of the 喜欢 / 不喜欢 stamp, following the drag up to the threshold. */
export function stampOpacity(dx: number, cardWidth: number): number {
  return clamp(Math.abs(dx) / swipeThreshold(cardWidth), 0, 1)
}

/** Where a committed card flies to: 1.2 viewport widths out, keeping the finger's vertical drift and tilt. */
export function exitPose(decision: Decision, from: CardPose, viewportWidth: number): CardPose {
  const sign = decision === 'like' ? 1 : -1
  const x = sign * Math.max(viewportWidth * 1.2, Math.abs(from.x) + 1)
  const rotate = sign * MAX_TILT_DEG * 1.5
  return { x, y: from.y + (from.y === 0 ? 0 : Math.sign(from.y) * 40), rotate }
}

/** Faster flicks leave faster: the remaining distance at the release speed, clamped to 200–280 ms. */
export function exitDuration(remainingPx: number, velocityX: number): number {
  const speed = Math.abs(velocityX)
  if (speed < 0.05) return EXIT_MAX_MS
  return Math.round(clamp(Math.abs(remainingPx) / speed, EXIT_MIN_MS, EXIT_MAX_MS))
}

export interface Sample {
  readonly x: number
  readonly t: number
}

/** px/ms over the samples of the last VELOCITY_WINDOW_MS (0 when there is not enough to measure). */
export function releaseVelocity(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  const recent = samples.filter((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS)
  const first = recent[0]
  if (!first || last.t - first.t < 1) return 0
  return (last.x - first.x) / (last.t - first.t)
}
