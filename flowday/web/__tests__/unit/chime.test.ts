import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _getChimeCount,
  _resetChime,
  playCompletionChime,
} from "@/lib/utils/chime";

interface FakeOscillator {
  type: string;
  frequency: { value: number };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  gain: {
    value: number;
    setValueAtTime: ReturnType<typeof vi.fn>;
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
}

interface FakeCompressor {
  threshold: { value: number };
  knee: { value: number };
  ratio: { value: number };
  attack: { value: number };
  release: { value: number };
  connect: ReturnType<typeof vi.fn>;
}

interface FakeAudioContext {
  state: string;
  currentTime: number;
  destination: object;
  resume: ReturnType<typeof vi.fn>;
  createOscillator: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  createDynamicsCompressor: ReturnType<typeof vi.fn>;
}

function makeFakeContext(): {
  ctx: FakeAudioContext;
  oscillators: FakeOscillator[];
  gains: FakeGain[];
  compressors: FakeCompressor[];
} {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const compressors: FakeCompressor[] = [];

  const ctx: FakeAudioContext = {
    state: "running",
    currentTime: 0,
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createOscillator: vi.fn(() => {
      const osc: FakeOscillator = {
        type: "",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }),
    createGain: vi.fn(() => {
      const gain: FakeGain = {
        gain: {
          value: 0,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
    createDynamicsCompressor: vi.fn(() => {
      const compressor: FakeCompressor = {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: vi.fn(),
      };
      compressors.push(compressor);
      return compressor;
    }),
  };

  return { ctx, oscillators, gains, compressors };
}

describe("playCompletionChime", () => {
  beforeEach(() => {
    _resetChime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetChime();
  });

  it("increments the chime count even when no AudioContext is available", () => {
    vi.stubGlobal("window", {});
    expect(_getChimeCount()).toBe(0);

    playCompletionChime();
    playCompletionChime();

    expect(_getChimeCount()).toBe(2);
  });

  it("plays a softer Beethoven-inspired Ode to Joy motif at half master gain", () => {
    const { ctx, oscillators, gains, compressors } = makeFakeContext();
    const Ctor = vi.fn(() => ctx);
    vi.stubGlobal("window", { AudioContext: Ctor });

    playCompletionChime();

    expect(Ctor).toHaveBeenCalledTimes(1);
    // Six melody notes × (fundamental + octave) = twelve oscillators.
    // Plus one master gain on top of the per-note gains (12 + 1 = 13).
    expect(oscillators).toHaveLength(12);
    expect(gains).toHaveLength(13);
    expect(compressors).toHaveLength(1);

    // Compression is intentionally light now — just enough to smooth overlaps.
    const compressor = compressors[0];
    expect(compressor.threshold.value).toBeCloseTo(-18);
    expect(compressor.ratio.value).toBeCloseTo(3);
    expect(compressor.attack.value).toBeCloseTo(0.01);

    // Master gain is set directly to half the previous 0.8 level.
    expect(gains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    expect(gains[0].gain.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(gains[0].gain.value).toBeCloseTo(0.4);

    for (const osc of oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
    }

    // Fundamentals alternate at even indices; overtones sit at odd indices.
    expect(oscillators[0].type).toBe("triangle");
    expect(oscillators[2].type).toBe("triangle");
    expect(oscillators[10].type).toBe("triangle");

    // Overtones are sine to keep the cue soft.
    expect(oscillators[1].type).toBe("sine");
    expect(oscillators[11].type).toBe("sine");

    // Melody fundamentals follow E5 → E5 → F5 → G5 → G5 → F5.
    expect(oscillators[0].frequency.value).toBeCloseTo(659.25);
    expect(oscillators[2].frequency.value).toBeCloseTo(659.25);
    expect(oscillators[4].frequency.value).toBeCloseTo(698.46);
    expect(oscillators[6].frequency.value).toBeCloseTo(783.99);
    expect(oscillators[8].frequency.value).toBeCloseTo(783.99);
    expect(oscillators[10].frequency.value).toBeCloseTo(698.46);

    // Octave overtones are 2× the fundamentals.
    expect(oscillators[1].frequency.value).toBeCloseTo(659.25 * 2);
    expect(oscillators[3].frequency.value).toBeCloseTo(659.25 * 2);
    expect(oscillators[5].frequency.value).toBeCloseTo(698.46 * 2);
    expect(oscillators[7].frequency.value).toBeCloseTo(783.99 * 2);
    expect(oscillators[9].frequency.value).toBeCloseTo(783.99 * 2);
    expect(oscillators[11].frequency.value).toBeCloseTo(698.46 * 2);

    // Per-note gains (skip master at index 0): 0.32 / 0.08.
    const peaks = gains
      .slice(1)
      .map((g) => g.gain.linearRampToValueAtTime.mock.calls[0]?.[0]);
    for (let i = 0; i < 6; i++) {
      expect(peaks[i * 2]).toBeCloseTo(0.32);
      expect(peaks[i * 2 + 1]).toBeCloseTo(0.08);
    }
  });

  it("resumes a suspended AudioContext before scheduling notes", () => {
    const { ctx } = makeFakeContext();
    ctx.state = "suspended";
    vi.stubGlobal("window", { AudioContext: vi.fn(() => ctx) });

    playCompletionChime();

    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(12);
  });

  it("reuses a single AudioContext across multiple chimes", () => {
    const { ctx } = makeFakeContext();
    const Ctor = vi.fn(() => ctx);
    vi.stubGlobal("window", { AudioContext: Ctor });

    playCompletionChime();
    playCompletionChime();
    playCompletionChime();

    expect(Ctor).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(36);
  });
});
