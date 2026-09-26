import test from "node:test";
import assert from "node:assert/strict";
import { emailHandler, deliverOne, runScheduled, fetchHandler, retryAfterMillis } from "../src/index.ts";

// Unit-test stand-in; Wrangler's local workerd test below exercises the real
// Cloudflare FixedLengthStream implementation and its R2 known-length check.
globalThis.FixedLengthStream = class {
  constructor() {
    const stream = new TransformStream();
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
};

class FakeBucket {
  objects = new Map();
  async put(key, value, options = {}) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const object = {
      key, bytes, size: bytes.length, uploaded: new Date(),
      customMetadata: options.customMetadata ?? {},
    };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...object,
      body: new Blob([object.bytes]).stream(),
    };
  }
  async delete(key) { this.objects.delete(key); }
  async list({ prefix, limit, cursor, include }) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const selected = keys.filter((key) => !cursor || key > cursor).slice(0, limit);
    return {
      objects: selected.map((key) => {
        const o = this.objects.get(key);
        return {
          key, size: o.size, uploaded: o.uploaded,
          customMetadata: include?.includes("customMetadata") ? o.customMetadata : undefined,
        };
      }),
      truncated: keys.some((key) => key > (selected.at(-1) ?? cursor ?? "")) && selected.length > 0,
      cursor: selected.at(-1),
    };
  }
  async json(key) {
    const object = this.objects.get(key);
    return object ? JSON.parse(new TextDecoder().decode(object.bytes)) : null;
  }
}

function env(bucket = new FakeBucket()) {
  return {
    MAIL_BUFFER: bucket,
    RECEIVE_ADDRESS: "inbox@mail.example.org",
    INGEST_URL: "https://mail.example.org/api/v1/ingest/email",
    INGEST_TOKEN: "inbound-secret",
    STATUS_TOKEN: "status-secret",
  };
}

function email(to = "inbox@mail.example.org", raw = "From: test@example.org\r\nSubject: Test\r\n\r\nhello") {
  return {
    from: "test@example.org", to,
    raw: new Blob([raw]).stream(), rawSize: new TextEncoder().encode(raw).length,
    rejected: null,
    setReject(reason) { this.rejected = reason; },
  };
}

function capturedContext() {
  const jobs = [];
  return { jobs, waitUntil(job) { jobs.push(job); } };
}

async function receive(mail, workerEnv) {
  const ctx = capturedContext();
  await emailHandler(mail, workerEnv, ctx);
  return ctx;
}

test("email waits for raw R2 commit and does not accept wrong address or oversize", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Response(null, { status: 204, headers: {
    "X-Mail-Hero-Ingest-Id": init.headers.get("X-Mail-Hero-Ingest-Id"),
  } });
  try {
  const workerEnv = env();
  const bad = email("other@mail.example.org");
  await receive(bad, workerEnv);
  assert.equal(bad.rejected, "Unknown recipient");
  const large = email();
  large.rawSize = 25 * 1024 * 1024 + 1;
  await receive(large, workerEnv);
  assert.equal(large.rejected, "Message too large");
  assert.equal(workerEnv.MAIL_BUFFER.objects.size, 0);

  let release;
  const originalPut = workerEnv.MAIL_BUFFER.put.bind(workerEnv.MAIL_BUFFER);
  workerEnv.MAIL_BUFFER.put = async (...args) => {
    await new Promise((resolve) => { release = resolve; });
    return originalPut(...args);
  };
  const ctx = capturedContext();
  const pending = emailHandler(email(), workerEnv, ctx);
  await Promise.resolve();
  assert.equal(ctx.jobs.length, 0);
  release();
  await pending;
  assert.equal(ctx.jobs.length, 1);
  assert.equal([...workerEnv.MAIL_BUFFER.objects.keys()].filter((key) => key.startsWith("pending/")).length, 1);
  await Promise.all(ctx.jobs);
  } finally { globalThis.fetch = oldFetch; }
});

test("204 with echoed ID deletes R2 original after the HTTP handoff", async () => {
  const workerEnv = env();
  const oldFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (_url, init) => {
    observed = {
      id: init.headers.get("X-Mail-Hero-Ingest-Id"),
      metadata: init.headers.get("X-Mail-Hero-Metadata"),
      token: init.headers.get("Authorization"),
      body: await new Response(init.body).text(),
    };
    return new Response(null, { status: 204, headers: { "X-Mail-Hero-Ingest-Id": observed.id } });
  };
  try {
    const ctx = await receive(email(), workerEnv);
    await Promise.all(ctx.jobs);
    assert.equal(observed.token, "Bearer inbound-secret");
    assert.equal(observed.body.endsWith("hello"), true);
    const metadata = JSON.parse(Buffer.from(observed.metadata, "base64url").toString());
    assert.equal(metadata.from, "test@example.org");
    assert.equal(metadata.size_bytes, new TextEncoder().encode(observed.body).length);
    assert.equal(workerEnv.MAIL_BUFFER.objects.size, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test("a 500 keeps the original and retries the same ID; missing acknowledgement pauses", async () => {
  const workerEnv = env();
  const oldFetch = globalThis.fetch;
  const ids = [];
  let count = 0;
  globalThis.fetch = async (_url, init) => {
    ids.push(init.headers.get("X-Mail-Hero-Ingest-Id"));
    count++;
    return count === 1
      ? new Response(null, { status: 500 })
      : new Response(null, { status: 204, headers: { "X-Mail-Hero-Ingest-Id": ids.at(-1) } });
  };
  try {
    const ctx = await receive(email(), workerEnv);
    await Promise.all(ctx.jobs);
    const id = ids[0];
    assert.ok(workerEnv.MAIL_BUFFER.objects.has(`pending/${id}.eml`));
    const state = await workerEnv.MAIL_BUFFER.json(`state/${id}.json`);
    assert.equal(state.kind, "retry");
    assert.equal(state.attempts, 1);
    assert.equal(await deliverOne(workerEnv, id, Date.now() + 24 * 60 * 60_000), "delivered");
    assert.deepEqual(ids, [id, id]);
    assert.equal(workerEnv.MAIL_BUFFER.objects.has(`pending/${id}.eml`), false);

    globalThis.fetch = async () => new Response(null, { status: 204 });
    const again = await receive(email(), workerEnv);
    await Promise.all(again.jobs);
    assert.equal((await workerEnv.MAIL_BUFFER.json("_control/paused.json")).reason, "ingest_contract_failed");
  } finally { globalThis.fetch = oldFetch; }
});

test("401 pauses globally until authenticated resume; 422 quarantines only one item", async () => {
  const workerEnv = env();
  const oldFetch = globalThis.fetch;
  let responseStatus = 401;
  globalThis.fetch = async () => new Response(null, { status: responseStatus });
  try {
    const first = await receive(email(), workerEnv);
    await Promise.all(first.jobs);
    assert.equal((await workerEnv.MAIL_BUFFER.json("_control/paused.json")).reason, "authentication_failed");
    const denied = await fetchHandler(new Request("https://worker.example/status"), workerEnv);
    assert.equal(denied.status, 404);
    const resume = await fetchHandler(new Request("https://worker.example/resume", {
      method: "POST", headers: { Authorization: "Bearer status-secret" },
    }), workerEnv);
    assert.equal(resume.status, 204);
    assert.equal(await workerEnv.MAIL_BUFFER.json("_control/paused.json"), null);
    responseStatus = 422;
    const id = [...workerEnv.MAIL_BUFFER.objects.keys()].find((key) => key.startsWith("pending/")).split("/")[1].slice(0, -4);
    assert.equal(await deliverOne(workerEnv, id), "quarantined");
    assert.equal((await workerEnv.MAIL_BUFFER.json(`state/${id}.json`)).kind, "quarantined");
    const status = await fetchHandler(new Request("https://worker.example/status", {
      headers: { Authorization: "Bearer status-secret" },
    }), workerEnv);
    assert.equal((await status.json()).quarantined, 1);
  } finally { globalThis.fetch = oldFetch; }
});

test("scheduled cursor advances beyond quarantined entries and reaches later mail", async () => {
  const workerEnv = env();
  for (let i = 0; i < 10; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const key = `pending/${id}.eml`;
    await workerEnv.MAIL_BUFFER.put(key, "From: a@b\r\n\r\nmail", {
      customMetadata: { ingest_id: id, from: "a@b", to: workerEnv.RECEIVE_ADDRESS,
        received_at: "2026-09-23T00:00:00Z", raw_size: String("From: a@b\r\n\r\nmail".length) },
    });
    workerEnv.MAIL_BUFFER.objects.get(key).uploaded = new Date(0);
    if (i < 8) await workerEnv.MAIL_BUFFER.put(`state/${id}.json`, JSON.stringify({
      kind: "quarantined", attempts: 1, next_attempt_at: null,
      last_error_code: "http_422", http_status: 422, updated_at: "2026-09-23T00:00:00Z",
    }));
  }
  const oldFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (_url, init) => {
    sent++;
    return new Response(null, { status: 204, headers: {
      "X-Mail-Hero-Ingest-Id": init.headers.get("X-Mail-Hero-Ingest-Id"),
    } });
  };
  try {
    await runScheduled(workerEnv, Date.now());
    assert.equal(sent, 0);
    assert.ok(await workerEnv.MAIL_BUFFER.json("_control/cursor.json"));
    await runScheduled(workerEnv, Date.now());
    assert.equal(sent, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test("Retry-After parses seconds/date and status never contains message body", async () => {
  const now = Date.parse("2026-09-23T00:00:00Z");
  assert.equal(retryAfterMillis("120", now), 120_000);
  assert.equal(retryAfterMillis("Wed, 23 Sep 2026 00:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMillis("bad", now), null);
  const workerEnv = env();
  const id = "00000000-0000-4000-8000-000000000099";
  await workerEnv.MAIL_BUFFER.put(`pending/${id}.eml`, "SECRET BODY", {
    customMetadata: { ingest_id: id, from: "a@b", to: workerEnv.RECEIVE_ADDRESS,
      received_at: "2026-09-23T00:00:00Z", raw_size: String("SECRET BODY".length) },
  });
  const result = await fetchHandler(new Request("https://worker.example/status", {
    headers: { Authorization: "Bearer status-secret" },
  }), workerEnv);
  const body = await result.text();
  assert.equal(body.includes("SECRET BODY"), false);
  assert.equal(body.includes("a@b"), false);
  assert.equal(JSON.parse(body).scanned, 1);
});

test("R2 write failure does not schedule a push or claim to have stored mail", async () => {
  const workerEnv = env();
  workerEnv.MAIL_BUFFER.put = async () => { throw new Error("simulated R2 outage"); };
  const ctx = capturedContext();
  await assert.rejects(() => emailHandler(email(), workerEnv, ctx), /simulated R2 outage/);
  assert.equal(ctx.jobs.length, 0);
});

test("429 Retry-After persists a minimum wait, while malformed metadata is isolated", async () => {
  const workerEnv = env();
  const id = "00000000-0000-4000-8000-000000000101";
  const key = `pending/${id}.eml`;
  await workerEnv.MAIL_BUFFER.put(key, "From: a@b\r\n\r\nmail", {
    customMetadata: { ingest_id: id, from: "", to: workerEnv.RECEIVE_ADDRESS,
      received_at: "2026-09-23T00:00:00Z", raw_size: String("From: a@b\r\n\r\nmail".length) },
  });
  workerEnv.MAIL_BUFFER.objects.get(key).uploaded = new Date(0);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
  };
  try {
    const now = Date.now();
    assert.equal(await deliverOne(workerEnv, id, now), "retry");
    const state = await workerEnv.MAIL_BUFFER.json(`state/${id}.json`);
    assert.ok(Date.parse(state.next_attempt_at) >= now + 120_000);
    assert.equal(await deliverOne(workerEnv, id, now + 60_000), "not_due");
    assert.equal(calls, 1);

    const badID = "00000000-0000-4000-8000-000000000102";
    await workerEnv.MAIL_BUFFER.put(`pending/${badID}.eml`, "bad", {
      customMetadata: { ingest_id: badID, from: "a@b" },
    });
    workerEnv.MAIL_BUFFER.objects.get(`pending/${badID}.eml`).uploaded = new Date(0);
    assert.equal(await deliverOne(workerEnv, badID, now), "quarantined");
    assert.equal((await workerEnv.MAIL_BUFFER.json(`state/${badID}.json`)).last_error_code, "invalid_metadata");
    assert.ok(workerEnv.MAIL_BUFFER.objects.has(`pending/${badID}.eml`));
  } finally { globalThis.fetch = oldFetch; }
});

test("a partial R2 object is never pushed even when cleanup after size mismatch fails", async () => {
  const workerEnv = env();
  const bucket = workerEnv.MAIL_BUFFER;
  const originalPut = bucket.put.bind(bucket);
  const originalDelete = bucket.delete.bind(bucket);
  bucket.put = async (key, value, options) => {
    if (!key.startsWith("pending/")) return originalPut(key, value, options);
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    return originalPut(key, bytes.slice(0, -1), options);
  };
  bucket.delete = async (key) => {
    if (key.startsWith("pending/")) throw new Error("simulated cleanup failure");
    return originalDelete(key);
  };
  const ctx = capturedContext();
  await assert.rejects(() => emailHandler(email(), workerEnv, ctx), /simulated cleanup failure/);
  assert.equal(ctx.jobs.length, 0);
  const key = [...bucket.objects.keys()].find((item) => item.startsWith("pending/"));
  const id = key.slice("pending/".length, -".eml".length);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("partial message escaped quarantine"); };
  try {
    assert.equal(await deliverOne(workerEnv, id), "quarantined");
    assert.equal((await bucket.json(`state/${id}.json`)).last_error_code, "invalid_metadata");
    assert.ok(bucket.objects.has(key));
  } finally { globalThis.fetch = oldFetch; }
});
