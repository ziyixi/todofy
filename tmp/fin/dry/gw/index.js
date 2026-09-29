var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/http.ts
var MESSAGES = {
  unauthorized: "\u672A\u767B\u5F55\u6216\u51ED\u636E\u65E0\u6548",
  csrf_failed: "\u9875\u9762\u5B89\u5168\u4EE4\u724C\u5DF2\u5931\u6548\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5",
  not_found: "\u627E\u4E0D\u5230\u8BE5\u8D44\u6E90",
  payload_too_large: "\u8BF7\u6C42\u4F53\u8D85\u8FC7 1 MiB",
  unsupported_media_type: "\u53EA\u63A5\u53D7 application/json",
  rate_limited: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
  maintenance: "\u670D\u52A1\u7EF4\u62A4\u4E2D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5",
  not_configured: "\u670D\u52A1\u7F3A\u5C11\u5FC5\u9700\u7684\u5BC6\u94A5\u914D\u7F6E",
  access_not_configured: "Cloudflare Access \u914D\u7F6E\u4E0D\u5B8C\u6574",
  unavailable: "\u4F9D\u8D56\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5"
};
var HttpError = class extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
  status;
  code;
  static {
    __name(this, "HttpError");
  }
};
var PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
var IMMUTABLE = "private, max-age=31536000, immutable";
function newRequestId() {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}
__name(newRequestId, "newRequestId");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
__name(jsonResponse, "jsonResponse");
function errorResponse(requestId, status, code, headers = {}) {
  console.log(JSON.stringify({ request_id: requestId, status, code }));
  const response = jsonResponse(
    { error: { code, message: MESSAGES[code], request_id: requestId } },
    status
  );
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
__name(errorResponse, "errorResponse");
function mediaType(headers) {
  return (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}
__name(mediaType, "mediaType");
function partition(text, separator) {
  const index = text.indexOf(separator);
  return index < 0 ? [text, ""] : [text.slice(0, index), text.slice(index + separator.length)];
}
__name(partition, "partition");
function cookieValues(request, name) {
  return (request.headers.get("cookie") ?? "").split(";").flatMap((pair) => {
    const [key, value] = partition(pair.trim(), "=");
    return key === name ? [value] : [];
  });
}
__name(cookieValues, "cookieValues");
function withPrivateHeaders(response, asset = false) {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) copy.headers.set(name, value);
  if (asset && response.status === 200 && mediaType(response.headers) !== "text/html") {
    copy.headers.set("cache-control", IMMUTABLE);
  }
  return copy;
}
__name(withPrivateHeaders, "withPrivateHeaders");
function nowSeconds() {
  return Math.floor(Date.now() / 1e3);
}
__name(nowSeconds, "nowSeconds");

// src/coordinator.ts
var INSTANCE = "inbox-v1";
var BASE = "https://coordinator";
function callCoordinator(env, requestId, path, call) {
  const headers = new Headers(call.headers);
  headers.set("x-todofy-internal", "1");
  headers.set("x-todofy-request-id", requestId);
  return env.COORDINATOR.getByName(INSTANCE).fetch(`${BASE}${path}`, {
    method: call.method,
    headers,
    body: call.body ?? null
  });
}
__name(callCoordinator, "callCoordinator");
async function forward(ctx, path, call) {
  try {
    return await callCoordinator(ctx.env, ctx.requestId, path, call);
  } catch {
    return errorResponse(ctx.requestId, 503, "unavailable");
  }
}
__name(forward, "forward");

// src/env.ts
function variable(env, name, fallback = "") {
  const value = env[name];
  return value === void 0 ? fallback : value.trim();
}
__name(variable, "variable");
function flag(env, name) {
  return variable(env, name) === "true";
}
__name(flag, "flag");
function csv(env, name) {
  return variable(env, name).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}
__name(csv, "csv");
function integer(env, name, fallback) {
  const value = variable(env, name);
  return /^\d+$/.test(value) ? Number(value) : fallback;
}
__name(integer, "integer");
function localDev(env) {
  return variable(env, "TODOFY_PUBLIC_HOST").toLowerCase().endsWith(".localhost");
}
__name(localDev, "localDev");

// src/crypto.ts
var encoder = new TextEncoder();
function utf8(text) {
  return encoder.encode(text);
}
__name(utf8, "utf8");
async function sha256Hex(data) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function timingSafeEqual(a, b) {
  const left = utf8(a);
  const right = utf8(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}
__name(timingSafeEqual, "timingSafeEqual");
function matchesAny(presented, digests) {
  let matched = false;
  for (const digest of digests) matched = timingSafeEqual(presented, digest) || matched;
  return matched;
}
__name(matchesAny, "matchesAny");
function fromBinary(binary) {
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
__name(fromBinary, "fromBinary");
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function base64UrlDecode(text) {
  const unpadded = text.replace(/={1,2}$/, "");
  if (!/^[A-Za-z0-9_-]*$/.test(unpadded) || unpadded.length % 4 === 1) return null;
  return fromBinary(atob(unpadded.replace(/-/g, "+").replace(/_/g, "/")));
}
__name(base64UrlDecode, "base64UrlDecode");
var STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function base64DecodeStrict(text) {
  return STRICT_BASE64.test(text) ? fromBinary(atob(text)) : null;
}
__name(base64DecodeStrict, "base64DecodeStrict");
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isJsonObject, "isJsonObject");
function decodeJsonSegment(segment) {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return void 0;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return void 0;
  }
}
__name(decodeJsonSegment, "decodeJsonSegment");

// src/hooks.ts
var MAX_EVENT_BYTES = 1024 * 1024;
var MAINTENANCE_RETRY_AFTER_S = "600";
var HOUR_S = 3600;
var lockedHour = null;
async function handleHooks(ctx) {
  const { method } = ctx.request;
  const path = ctx.url.pathname;
  if (method === "POST" && path === "/hooks/mail") return mail(ctx);
  if (method === "GET" && path === "/api/summary") return report(ctx, "summary");
  if (method === "GET" && path === "/api/recommendation") return report(ctx, "recommendation");
  if (method === "GET" && path === "/health") return health(ctx);
  return errorResponse(ctx.requestId, 404, "not_found");
}
__name(handleHooks, "handleHooks");
function health(ctx) {
  return jsonResponse({
    build: variable(ctx.env, "BUILD_SHA", "unknown"),
    service: "todofy",
    status: "healthy",
    timestamp: `${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}Z`
  });
}
__name(health, "health");
async function bearerOk(header, digests) {
  const [scheme, token2] = partition(header, " ");
  if (scheme !== "Bearer" || !token2 || token2.includes(" ")) return false;
  return matchesAny(await sha256Hex(utf8(token2)), digests);
}
__name(bearerOk, "bearerOk");
async function mail(ctx) {
  const { env, request, requestId } = ctx;
  const digests = ["MAIL_WEBHOOK_TOKEN_SHA256", "MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS"].map((name) => variable(env, name).toLowerCase()).filter(Boolean);
  if (digests.length === 0) return errorResponse(requestId, 503, "not_configured");
  if (!await bearerOk(request.headers.get("authorization") ?? "", digests)) {
    return errorResponse(requestId, 401, "unauthorized");
  }
  if (flag(env, "MAINTENANCE_MODE")) {
    return errorResponse(requestId, 503, "maintenance", { "retry-after": MAINTENANCE_RETRY_AFTER_S });
  }
  if (mediaType(request.headers) !== "application/json") {
    return errorResponse(requestId, 415, "unsupported_media_type");
  }
  const length = request.headers.get("content-length") ?? "";
  if (/^\d+$/.test(length) && Number(length) > MAX_EVENT_BYTES) {
    return errorResponse(requestId, 413, "payload_too_large");
  }
  const headers = { "content-type": "application/json" };
  const key = request.headers.get("idempotency-key");
  if (key !== null) headers["idempotency-key"] = key;
  return forward(ctx, "/ingest", { method: "POST", headers, body: request.body });
}
__name(mail, "mail");
async function basicOk(header, digests) {
  const [scheme, encoded] = partition(header, " ");
  if (scheme.toLowerCase() !== "basic") return false;
  const credentials = base64DecodeStrict(encoded.trim());
  return credentials !== null && matchesAny(await sha256Hex(credentials), digests);
}
__name(basicOk, "basicOk");
async function report(ctx, kind) {
  const digests = csv(ctx.env, "REPORT_BASIC_AUTH_SHA256");
  if (digests.length === 0) return errorResponse(ctx.requestId, 503, "not_configured");
  if (await basicOk(ctx.request.headers.get("authorization") ?? "", digests)) {
    return forward(ctx, `/newsletter/${kind}${ctx.url.search}`, { method: "GET" });
  }
  const now = nowSeconds();
  const hour = new Date(now * 1e3).toISOString().slice(0, 13);
  if (hour === lockedHour) {
    return errorResponse(ctx.requestId, 429, "rate_limited", {
      "retry-after": String(HOUR_S - now % HOUR_S)
    });
  }
  const response = await forward(ctx, "/newsletter/auth-failure", { method: "POST" });
  if (response.status === 429) lockedHour = hour;
  return response;
}
__name(report, "report");

// src/access.ts
var ACCESS_ISSUER = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
var LOOPBACK_ISSUER = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
var MAX_TOKEN_CHARS = 16e3;
var JWKS_TTL_MS = 36e5;
var JWKS_REFRESH_COOLDOWN_MS = 6e4;
var JWKS_TIMEOUT_MS = 5e3;
var CLOCK_SKEW_S = 60;
var MAX_ALIASES = 8;
var MAX_ALIASES_CHARS = 2048;
var RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
var keySets = /* @__PURE__ */ new Map();
function unauthorized() {
  return new HttpError(401, "unauthorized");
}
__name(unauthorized, "unauthorized");
function issuer(env) {
  const value = variable(env, "ACCESS_ISSUER").replace(/\/+$/, "");
  if (ACCESS_ISSUER.test(value)) return value;
  if (localDev(env) && flag(env, "DEV_ACCESS_LOOPBACK_ISSUER") && LOOPBACK_ISSUER.test(value)) {
    return value;
  }
  throw new HttpError(503, "access_not_configured");
}
__name(issuer, "issuer");
function ownerEmails(env, owner) {
  const aliases = csv(env, "ACCESS_OWNER_ALIASES");
  if (variable(env, "ACCESS_OWNER_ALIASES").length > MAX_ALIASES_CHARS || aliases.length > MAX_ALIASES) {
    throw new HttpError(503, "access_not_configured");
  }
  return /* @__PURE__ */ new Set([owner, ...aliases]);
}
__name(ownerEmails, "ownerEmails");
function token(request) {
  const value = request.headers.get("cf-access-jwt-assertion") || cookieValues(request, "CF_Authorization").at(-1);
  if (!value || value.length > MAX_TOKEN_CHARS) throw unauthorized();
  return value;
}
__name(token, "token");
async function fetchKeys(issuerUrl) {
  let body;
  try {
    const response = await fetch(`${issuerUrl}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS)
    });
    if (response.status !== 200) throw new Error("certs");
    body = await response.json();
  } catch {
    throw new HttpError(503, "unavailable");
  }
  const keys = /* @__PURE__ */ new Map();
  const jwks = isJsonObject(body) && Array.isArray(body.keys) ? body.keys : [];
  for (const jwk of jwks) {
    if (!isJsonObject(jwk) || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
    try {
      const key = { kty: "RSA", n: jwk.n, e: jwk.e };
      keys.set(jwk.kid, await crypto.subtle.importKey("jwk", key, RS256, false, ["verify"]));
    } catch {
    }
  }
  return keys;
}
__name(fetchKeys, "fetchKeys");
async function signingKey(issuerUrl, kid, cooldownMs) {
  if (typeof kid !== "string") return null;
  const cached = keySets.get(issuerUrl);
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < JWKS_TTL_MS && (cached.keys.has(kid) || age < cooldownMs)) return cached.keys.get(kid) ?? null;
  }
  const keys = await fetchKeys(issuerUrl);
  keySets.set(issuerUrl, { fetchedAt: Date.now(), keys });
  return keys.get(kid) ?? null;
}
__name(signingKey, "signingKey");
function claimsValid(claims, issuerUrl, audience, emails) {
  const now = nowSeconds();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return claims.iss === issuerUrl && audiences.includes(audience) && typeof claims.exp === "number" && claims.exp > now && typeof claims.iat === "number" && claims.iat < now + CLOCK_SKEW_S && (claims.nbf === void 0 || typeof claims.nbf === "number" && claims.nbf <= now + CLOCK_SKEW_S) && typeof claims.sub === "string" && claims.sub !== "" && typeof claims.email === "string" && emails.has(claims.email.toLowerCase());
}
__name(claimsValid, "claimsValid");
async function authenticate(request, env) {
  const owner = variable(env, "ACCESS_OWNER").toLowerCase();
  if (localDev(env) && flag(env, "DEV_AUTH_BYPASS") && !request.headers.has("cf-ray")) return owner;
  const issuerUrl = issuer(env);
  const audience = variable(env, "ACCESS_AUDIENCE");
  if (!audience || !owner) throw new HttpError(503, "access_not_configured");
  const emails = ownerEmails(env, owner);
  const parts = token(request).split(".");
  if (parts.length !== 3) throw unauthorized();
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
  const header = decodeJsonSegment(headerPart);
  const claims = decodeJsonSegment(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (!isJsonObject(header) || header.alg !== "RS256" || !isJsonObject(claims) || signature === null) {
    throw unauthorized();
  }
  const cooldownMs = integer(env, "JWKS_REFRESH_COOLDOWN_MS", JWKS_REFRESH_COOLDOWN_MS);
  const key = await signingKey(issuerUrl, header.kid, cooldownMs);
  const signed = utf8(`${headerPart}.${payloadPart}`);
  if (key === null || !await crypto.subtle.verify(RS256.name, key, signature, signed)) {
    throw unauthorized();
  }
  if (!claimsValid(claims, issuerUrl, audience, emails)) throw unauthorized();
  return owner;
}
__name(authenticate, "authenticate");

// src/csrf.ts
var COOKIE = "todofy_csrf";
var HEADER = "x-csrf-token";
var TTL_S = 12 * 3600;
var MAX_TOKEN_CHARS2 = 1024;
var SIGNING_KEY = /^[0-9a-fA-F]{64}$/;
function failed() {
  return new HttpError(403, "csrf_failed");
}
__name(failed, "failed");
async function signingKey2(env) {
  const hex = variable(env, "CSRF_SIGNING_KEY");
  if (!SIGNING_KEY.test(hex)) throw new HttpError(503, "not_configured");
  const raw = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
__name(signingKey2, "signingKey");
async function sign(key, payload) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(payload))));
}
__name(sign, "sign");
function allowedOrigins(ctx) {
  const origins = /* @__PURE__ */ new Set([`https://${variable(ctx.env, "TODOFY_PUBLIC_HOST").toLowerCase()}`]);
  if (localDev(ctx.env)) origins.add(`http://${ctx.url.host.toLowerCase()}`);
  return origins;
}
__name(allowedOrigins, "allowedOrigins");
async function issueCsrf(ctx, owner) {
  const key = await signingKey2(ctx.env);
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const claims = { kind: "csrf", owner, nonce, exp: nowSeconds() + TTL_S };
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  const token2 = `${payload}.${await sign(key, payload)}`;
  const secure = ctx.url.protocol === "https:" ? "; Secure" : "";
  const response = jsonResponse({ token: token2 });
  response.headers.set(
    "set-cookie",
    `${COOKIE}=${token2}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(TTL_S)}${secure}`
  );
  return response;
}
__name(issueCsrf, "issueCsrf");
async function verifyCsrf(ctx, owner) {
  const key = await signingKey2(ctx.env);
  const { headers } = ctx.request;
  const provided = headers.get(HEADER) ?? "";
  const cookie = cookieValues(ctx.request, COOKIE)[0] ?? "";
  if (!allowedOrigins(ctx).has((headers.get("origin") ?? "").toLowerCase()) || !provided || provided.length > MAX_TOKEN_CHARS2 || !timingSafeEqual(provided, cookie)) {
    throw failed();
  }
  const [payload, signature] = partition(provided, ".");
  if (!timingSafeEqual(signature, await sign(key, payload))) throw failed();
  const claims = decodeJsonSegment(payload);
  if (!isJsonObject(claims) || claims.kind !== "csrf" || claims.owner !== owner || typeof claims.exp !== "number" || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds()) {
    throw failed();
  }
}
__name(verifyCsrf, "verifyCsrf");

// src/owner.ts
var READ_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD"]);
var MAINTENANCE_RETRY_AFTER_S2 = "300";
async function handleOwner(ctx) {
  const path = ctx.url.pathname;
  try {
    const owner = await authenticate(ctx.request, ctx.env);
    if (path.startsWith("/api/")) return withPrivateHeaders(await api(ctx, owner));
    return withPrivateHeaders(await ctx.env.ASSETS.fetch(ctx.request), path.startsWith("/assets/"));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return withPrivateHeaders(errorResponse(ctx.requestId, error.status, error.code));
  }
}
__name(handleOwner, "handleOwner");
async function api(ctx, owner) {
  const { method } = ctx.request;
  const path = ctx.url.pathname;
  if (!READ_METHODS.has(method)) {
    await verifyCsrf(ctx, owner);
    if (flag(ctx.env, "MAINTENANCE_MODE")) {
      return errorResponse(ctx.requestId, 503, "maintenance", { "retry-after": MAINTENANCE_RETRY_AFTER_S2 });
    }
  }
  if (method === "GET" && path === "/api/v1/csrf") return issueCsrf(ctx, owner);
  if (method === "GET" && path === "/api/v1/setup") return setup(ctx, owner);
  if (!path.startsWith("/api/v1/")) return errorResponse(ctx.requestId, 404, "not_found");
  const headers = { "x-todofy-owner": owner };
  for (const name of ["content-type", "content-length"]) {
    const value = ctx.request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const body = READ_METHODS.has(method) ? null : ctx.request.body;
  return forward(ctx, `${path}${ctx.url.search}`, { method, headers, body });
}
__name(api, "api");
async function setup(ctx, owner) {
  const { env } = ctx;
  let core;
  try {
    const response = await callCoordinator(env, ctx.requestId, "/setup", { method: "GET" });
    if (response.status !== 200) throw new Error("setup");
    core = await response.json();
  } catch {
    return errorResponse(ctx.requestId, 503, "unavailable");
  }
  if (!isJsonObject(core) || typeof core.mail_source_id !== "string" || !isJsonObject(core.configured)) {
    return errorResponse(ctx.requestId, 503, "unavailable");
  }
  return jsonResponse({
    build: variable(env, "BUILD_SHA", "unknown"),
    public_host: variable(env, "TODOFY_PUBLIC_HOST").toLowerCase(),
    hooks_hosts: csv(env, "TODOFY_HOOKS_HOSTS"),
    webhook_path: "/hooks/mail",
    mail_source_id: core.mail_source_id,
    access_owner: owner,
    configured: {
      mail_webhook_token: Boolean(variable(env, "MAIL_WEBHOOK_TOKEN_SHA256")),
      report_basic_auth: Boolean(variable(env, "REPORT_BASIC_AUTH_SHA256")),
      ...core.configured
    }
  });
}
__name(setup, "setup");

// src/index.ts
function route(ctx) {
  const host = ctx.url.hostname.toLowerCase();
  if (host === variable(ctx.env, "TODOFY_PUBLIC_HOST").toLowerCase()) return handleOwner(ctx);
  if (csv(ctx.env, "TODOFY_HOOKS_HOSTS").includes(host)) return handleHooks(ctx);
  return Promise.resolve(errorResponse(ctx.requestId, 404, "not_found"));
}
__name(route, "route");
var index_default = {
  async fetch(request, env) {
    const ctx = { request, env, url: new URL(request.url), requestId: newRequestId() };
    const response = await route(ctx);
    if (request.body !== null && !request.body.locked) await request.body.cancel();
    return response;
  },
  // A failed wake fails the cron invocation, which shows in Workers Logs; the next tick retries.
  async scheduled(_controller, env) {
    await callCoordinator(env, newRequestId(), "/wake", { method: "POST" });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
