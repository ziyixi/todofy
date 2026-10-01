type AudioContextCtor = typeof AudioContext;

let audioContext: AudioContext | null = null;
let chimeCount = 0;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;

  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext;

  if (!Ctor) return null;

  if (!audioContext) {
    try {
      audioContext = new Ctor();
    } catch {
      return null;
    }
  }

  return audioContext;
}

// Replaced with a softer public-domain Beethoven reference: the opening of
// "Ode to Joy" (E–E–F–G–G–F). The tone is intentionally gentler than the old
// alert-style chime: master gain is halved, compression is light, and the
// waveform stack uses triangle/sine instead of bright sawtooth layers.
export function playCompletionChime(): void {
  chimeCount++;

  const ctx = getAudioContext();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }

  let compressor: DynamicsCompressorNode;
  let master: GainNode;
  try {
    compressor = ctx.createDynamicsCompressor();
    master = ctx.createGain();
  } catch {
    return;
  }

  compressor.threshold.value = -18;
  compressor.knee.value = 10;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.2;
  master.gain.value = 0.4;

  compressor.connect(master);
  master.connect(ctx.destination);

  const now = ctx.currentTime;
  const notes = [
    { freq: 659.25, offset: 0 },    // E5
    { freq: 659.25, offset: 0.16 }, // E5
    { freq: 698.46, offset: 0.32 }, // F5
    { freq: 783.99, offset: 0.48 }, // G5
    { freq: 783.99, offset: 0.64 }, // G5
    { freq: 698.46, offset: 0.8 },  // F5
  ];

  for (const { freq, offset } of notes) {
    playBellNote(ctx, compressor, freq, now + offset, 0.24);
  }
}

function playBellNote(
  ctx: AudioContext,
  destination: AudioNode,
  freq: number,
  start: number,
  duration: number
): void {
  // Triangle fundamental keeps the melody warm; a faint sine octave adds a
  // little lift without turning the cue into a piercing alarm.
  const layers: Array<{ type: OscillatorType; multiplier: number; gain: number }> = [
    { type: "triangle", multiplier: 1, gain: 0.32 },
    { type: "sine", multiplier: 2, gain: 0.08 },
  ];

  for (const { type, multiplier, gain: peakGain } of layers) {
    let osc: OscillatorNode;
    let gain: GainNode;
    try {
      osc = ctx.createOscillator();
      gain = ctx.createGain();
    } catch {
      return;
    }

    osc.type = type;
    osc.frequency.value = freq * multiplier;

    const peak = start + 0.012;
    const end = start + duration;

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peakGain, peak);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

// Test-only — exposed for unit/integration/UI tests to verify the chime fired.
export function _getChimeCount(): number {
  return chimeCount;
}

export function _resetChime(): void {
  chimeCount = 0;
  audioContext = null;
}
