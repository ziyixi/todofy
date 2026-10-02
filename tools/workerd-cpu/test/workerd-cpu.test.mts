// node --test tools/workerd-cpu/test/*.test.mts (the Changes job). The parts that need no workerd: reading a profile,
// the summaries, the scale, the calibration workload itself, the isolates' medians (fake isolates) and the meter's
// failures on a stuck or closed inspector (a fake inspector on loopback). The apps' CPU tests run the meter against
// their Workers in workerd.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  CALIBRATION_CALL,
  CALIBRATION_CHARS,
  CALIBRATION_SETUP,
  connectCpuMeter,
  disturbed,
  inReference,
  MAX_SAMPLE_US,
  MAX_SPEED,
  MAX_WALL_OVER_CPU,
  measureInIsolates,
  medianAcross,
  profileCpu,
  scaleFor,
  summarize,
  within,
  type Calibration,
  type CpuMeter,
  type Measurement,
  type Profile,
} from '../workerd-cpu.mts';

function profile(samples: [string, number][]): Profile {
  const names = [...new Set(samples.map(([name]) => name))];
  return {
    nodes: names.map((functionName, index) => ({ id: index + 1, callFrame: { functionName } })),
    samples: samples.map(([name]) => names.indexOf(name) + 1),
    timeDeltas: samples.map(([, micros]) => micros),
  };
}

test('a profile counts every sample but idle ones, each capped at four sampling intervals', () => {
  const { ms, byFunction } = profileCpu(profile([['(idle)', 5000], ['parse', 100], ['parse', 120], ['sort', 9000], ['(program)', 80]]));
  assert.equal(ms, (100 + 120 + MAX_SAMPLE_US + 80) / 1000);
  assert.deepEqual([...byFunction.entries()], [['parse', 220], ['sort', MAX_SAMPLE_US], ['(program)', 80]]);
  assert.equal(profileCpu(profile([])).ms, 0);
});

test('a measurement is the first run, then the median and best of the warm runs', () => {
  assert.deepEqual(summarize('x', [4, 1, 3, 2]), { label: 'x', first: 4, median: 2, best: 1 });
  // An even count takes the upper median, as the calibration does.
  assert.deepEqual(summarize('x', [9, 1, 2, 3, 4]), { label: 'x', first: 9, median: 3, best: 1 });
  // A single run is its own warm numbers.
  assert.deepEqual(summarize('x', [5]), { label: 'x', first: 5, median: 5, best: 5 });
});

test('a faster machine never tightens a bound; a slower one widens it', () => {
  assert.equal(scaleFor(0.8), 1);
  assert.equal(scaleFor(1), 1);
  assert.equal(scaleFor(2.5), 2.5);
});

test('the calibration workload is deterministic and returns CALIBRATION_CHARS', () => {
  // The reference time (CALIBRATION_REFERENCE_MS) was measured for exactly this work: a change to the workload must
  // change this number too, which is the reminder to measure the reference again.
  const context: Record<string, unknown> = {};
  runInNewContext(CALIBRATION_SETUP, context);
  assert.equal(runInNewContext(CALIBRATION_CALL, context), CALIBRATION_CHARS);
  assert.equal(runInNewContext(CALIBRATION_CALL, context), CALIBRATION_CHARS);
});

function calibration(speed: number): Calibration {
  return { wall: speed * 4.8, cpu: speed * 4.8, speed };
}

test('reference milliseconds divide every number by the scale of the isolate that measured it', () => {
  const measured = { label: 'x', first: 6, median: 3, best: 2 };
  assert.deepEqual(inReference(measured, calibration(2)), { label: 'x', first: 3, median: 1.5, best: 1 });
  assert.deepEqual(inReference(measured, calibration(0.7)), measured);
});

test("the median across isolates is each number's, label by label, over the isolates that measured it", () => {
  const medians = medianAcross([
    [{ label: 'cold', first: 5, median: 5, best: 5 }, { label: 'deck', first: 2, median: 1, best: 0.5 }],
    [{ label: 'cold', first: 9, median: 9, best: 9 }, { label: 'deck', first: 1, median: 1.2, best: 0.4 }],
    [{ label: 'cold', first: 4, median: 4, best: 4 }, { label: 'deck', first: 3, median: 0.8, best: 0 }, { label: 'once', first: 7, median: 6, best: 5 }],
  ]);
  // One isolate's outlier (9) does not decide the cold number; a label measured once is that isolate's numbers.
  assert.deepEqual([...medians.values()], [
    { label: 'cold', first: 5, median: 5, best: 5 },
    { label: 'deck', first: 2, median: 1, best: 0.4 },
    { label: 'once', first: 7, median: 6, best: 5 },
  ]);
  assert.throws(() => medianAcross([[{ label: 'a', first: 1, median: 1, best: 1 }, { label: 'a', first: 2, median: 2, best: 2 }]]), /measured twice/);
});

/** A meter whose calibration reports `speed` (or a whole calibration) and that records the order of the calls. */
function fakeMeter(speed: number | Calibration, log: string[], index: number): CpuMeter {
  return {
    cpu: () => Promise.reject(new Error('not measured here')),
    measure: () => Promise.reject(new Error('not measured here')),
    calibrate: () => {
      log.push(`calibrate ${String(index)}`);
      return Promise.resolve(typeof speed === 'number' ? calibration(speed) : speed);
    },
    close: () => undefined,
  };
}

test('a calibration whose wall time is well above its profile CPU measured a busy moment', () => {
  assert.equal(disturbed({ wall: 5.2, cpu: 5, speed: 1.08 }), false);
  assert.equal(disturbed({ wall: 5 * MAX_WALL_OVER_CPU, cpu: 5, speed: 1.25 }), false);
  // The isolate that hid an injected regression: a busy moment read as a machine 2.6 times slower.
  assert.equal(disturbed({ wall: 12.59, cpu: 5.61, speed: 2.62 }), true);
});

test('an isolate with a disturbed calibration is measured again, at most as many more times as asked for', async () => {
  const busy: Calibration = { wall: 12.6, cpu: 5.6, speed: 2.62 };
  const run = async (calibrations: Calibration[]) => {
    const started: number[] = [];
    const result = await measureInIsolates(
      3,
      (index) => {
        started.push(index);
        return Promise.resolve({ meter: fakeMeter(calibrations[index] ?? calibration(1), [], index), dispose: () => Promise.resolve() });
      },
      (_isolate, index) => {
        // A regression of 10 raw ms in every isolate; the busy ones divide it by 2.62.
        const measurements: Measurement[] = [{ label: 'cold', first: 10, median: 10, best: 10 }];
        if (index === 0) measurements.push({ label: 'first isolate only', first: 1, median: 1, best: 1 });
        return Promise.resolve(measurements);
      },
    );
    return { started, cold: result.reference.get('cold')?.first, once: result.reference.get('first isolate only')?.first };
  };
  // Two of the first three were busy: two more isolates, and the regression shows in full; a label measured only in a
  // replaced isolate keeps that isolate's number.
  assert.deepEqual(await run([busy, busy, calibration(1), calibration(1), calibration(1)]), { started: [0, 1, 2, 3, 4], cold: 10, once: 1 / 2.62 });
  // Busy throughout: six isolates, then every one counts (as lenient as before, MAX_SPEED aside).
  assert.deepEqual(await run(Array.from({ length: 8 }, () => busy)), { started: [0, 1, 2, 3, 4, 5], cold: 10 / 2.62, once: 1 / 2.62 });
});

test('every isolate runs the session, then calibrates, then is disposed; bounds read the medians in reference ms', async () => {
  const log: string[] = [];
  const speeds = [1, 2, 0.5];
  const colds = [5, 18, 4];
  const result = await measureInIsolates(
    3,
    (index) => {
      log.push(`start ${String(index)}`);
      return Promise.resolve({
        meter: fakeMeter(speeds[index] ?? 1, log, index),
        cold: colds[index] ?? 0,
        dispose: () => {
          log.push(`dispose ${String(index)}`);
          return Promise.resolve();
        },
      });
    },
    (isolate, index) => {
      log.push(`session ${String(index)}`);
      const measurements: Measurement[] = [{ label: 'cold', first: isolate.cold, median: isolate.cold, best: isolate.cold }];
      if (index === 2) measurements.push({ label: 'last isolate only', first: 3, median: 2, best: 1 });
      return Promise.resolve(measurements);
    },
  );
  assert.deepEqual(log, ['start 0', 'session 0', 'calibrate 0', 'dispose 0', 'start 1', 'session 1', 'calibrate 1', 'dispose 1', 'start 2', 'session 2', 'calibrate 2', 'dispose 2']);
  // In reference ms: 5, 18 / 2 = 9 and 4 (a faster isolate is not scaled up): the median is 5.
  assert.deepEqual(result.runs.map((run) => run.reference[0]?.first), [5, 9, 4]);
  assert.equal(result.reference.get('cold')?.first, 5);
  assert.deepEqual(result.reference.get('last isolate only'), { label: 'last isolate only', first: 3, median: 2, best: 1 });
});

test('an isolate is disposed when its session fails, and the failure is the error', async () => {
  const log: string[] = [];
  await assert.rejects(
    measureInIsolates(
      3,
      (index) => Promise.resolve({ meter: fakeMeter(1, log, index), dispose: () => Promise.resolve(void log.push(`dispose ${String(index)}`)) }),
      (_isolate, index) => (index === 1 ? Promise.reject(new Error('the request failed')) : Promise.resolve([])),
    ),
    /the request failed/,
  );
  assert.deepEqual(log, ['calibrate 0', 'dispose 0', 'dispose 1']);
});

test('one isolate too busy to measure is outvoted; most of them fail the test', async () => {
  const run = (speeds: number[]) =>
    measureInIsolates(
      speeds.length,
      (index) => Promise.resolve({ meter: fakeMeter(speeds[index] ?? 1, [], index), dispose: () => Promise.resolve() }),
      () => Promise.resolve([{ label: 'cold', first: 5, median: 5, best: 5 }]),
    );
  // The busy isolate reads 5 / 8; the median is the lower of the two measurable isolates' numbers.
  assert.equal((await run([1.2, MAX_SPEED + 3, 1.1])).reference.get('cold')?.first, 5 / 1.2);
  await assert.rejects(run([MAX_SPEED + 1, 1.2, MAX_SPEED + 2]), /beyond MAX_SPEED/);
  await assert.rejects(run([]), /at least one isolate/);
});

test('within settles with its promise, or fails naming what did not happen in time', async () => {
  assert.equal(await within(1000, 'quick', Promise.resolve(7)), 7);
  await assert.rejects(within(20, 'the inspector answering Profiler.stop', new Promise(() => undefined)), /answering Profiler\.stop: nothing within 20 ms/);
});

/**
 * A fake inspector on loopback: GET /json lists one target, `core:user:w`; `upgrade` decides what the WebSocket
 * upgrade gets. Its `getInspectorURL` is Miniflare's.
 */
async function fakeInspector(upgrade: (socket: Socket, key: string) => void, json = true): Promise<{ close: () => void; getInspectorURL: () => Promise<URL> }> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (!json) return; // never answers
    const { port } = server.address() as { port: number };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 'core:user:w', webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/w` }]));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket: Socket) => {
    upgrade(socket, String(request.headers['sec-websocket-key']));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    // Every socket, upgraded ones too (the server no longer tracks those): nothing keeps the test process alive.
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
    getInspectorURL: () => Promise.resolve(new URL(`ws://127.0.0.1:${String(port)}`)),
  };
}

/** Completes the WebSocket handshake (RFC 6455 section 4.2.2) and then sends nothing. */
function accept(socket: Socket, key: string): void {
  const digest = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
}

async function failure(upgrade: (socket: Socket, key: string) => void, json = true): Promise<string> {
  const inspector = await fakeInspector(upgrade, json);
  try {
    await connectCpuMeter(inspector, 'w', 200);
    return 'connected';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    inspector.close();
  }
}

test('a stuck or closed inspector fails the meter with the step it was in, never a hang', async () => {
  assert.match(await failure(accept, false), /targets at 127\.0\.0\.1:\d+/);
  // The upgrade is never answered.
  assert.match(await failure(() => undefined), /connecting to the inspector of the Worker w: nothing within 200 ms/);
  // Connected, but the first call is never answered.
  assert.match(await failure(accept), /answering Runtime\.enable: nothing within 200 ms/);
  // Connected, then closed (as a second client of Miniflare's inspector proxy is): the pending call fails at once.
  assert.match(
    await failure((socket, key) => {
      accept(socket, key);
      setTimeout(() => socket.end(Buffer.from([0x88, 0x00])), 20);
    }),
    /inspector connection of the Worker w closed/,
  );
  const empty = await fakeInspector(accept);
  try {
    await assert.rejects(connectCpuMeter(empty, 'other', 200), /no inspector target for the Worker other/);
  } finally {
    empty.close();
  }
});
