import {
  EXIT_MAX_MS,
  EXIT_MIN_MS,
  MAX_TILT_DEG,
  dragPose,
  exitDuration,
  exitPose,
  lockAxis,
  releaseDecision,
  releaseVelocity,
  stampOpacity,
  swipeThreshold,
} from './swipe'

describe('swipe physics (docs/ux.md §3)', () => {
  it('commits at 30 % of the card width, clamped to 96–160 px', () => {
    expect(swipeThreshold(200)).toBe(96)
    expect(swipeThreshold(400)).toBe(120)
    expect(swipeThreshold(900)).toBe(160)
    expect(swipeThreshold(0)).toBe(96)
  })

  it('locks the axis only after 8 px, preferring a scroll when vertical dominates', () => {
    expect(lockAxis(5, 3)).toBeNull()
    expect(lockAxis(9, 2)).toBe('x')
    expect(lockAxis(-12, 4)).toBe('x')
    expect(lockAxis(4, 12)).toBe('y')
    expect(lockAxis(10, 10)).toBe('y')
  })

  it('decides on distance in either direction', () => {
    expect(releaseDecision(121, 0, 400)).toBe('like')
    expect(releaseDecision(-121, 0, 400)).toBe('dislike')
    expect(releaseDecision(119, 0, 400)).toBeNull()
  })

  it('decides on a flick: ≥ 0.5 px/ms, ≥ 40 px, same direction', () => {
    expect(releaseDecision(45, 0.6, 400)).toBe('like')
    expect(releaseDecision(-45, -0.6, 400)).toBe('dislike')
    expect(releaseDecision(35, 0.9, 400)).toBeNull()
    expect(releaseDecision(45, 0.4, 400)).toBeNull()
    // Flicking back towards the centre springs back.
    expect(releaseDecision(60, -0.8, 400)).toBeNull()
  })

  it('tilts up to 12° and never under reduced motion', () => {
    expect(dragPose(200, 0, 400, false).rotate).toBeCloseTo(6)
    expect(dragPose(2000, 0, 400, false).rotate).toBe(MAX_TILT_DEG)
    expect(dragPose(-2000, 0, 400, false).rotate).toBe(-MAX_TILT_DEG)
    expect(dragPose(200, 100, 400, true)).toEqual({ x: 200, y: 15, rotate: 0 })
  })

  it('fades the stamp in with the drag', () => {
    expect(stampOpacity(0, 400)).toBe(0)
    expect(stampOpacity(60, 400)).toBeCloseTo(0.5)
    expect(stampOpacity(-500, 400)).toBe(1)
  })

  it('flies out past the viewport, faster for faster flicks', () => {
    expect(exitPose('like', { x: 100, y: 0, rotate: 3 }, 400).x).toBeGreaterThanOrEqual(480)
    expect(exitPose('dislike', { x: 0, y: 0, rotate: 0 }, 400).x).toBeLessThanOrEqual(-480)
    expect(exitDuration(400, 0)).toBe(EXIT_MAX_MS)
    expect(exitDuration(400, 5)).toBe(EXIT_MIN_MS)
    expect(exitDuration(480, 2)).toBe(240)
  })

  it('measures the release velocity over the last 100 ms only', () => {
    expect(releaseVelocity([])).toBe(0)
    expect(releaseVelocity([{ x: 0, t: 0 }])).toBe(0)
    expect(releaseVelocity([{ x: 0, t: 0 }, { x: 500, t: 1000 }, { x: 520, t: 1050 }, { x: 560, t: 1100 }])).toBeCloseTo(0.6)
  })
})
