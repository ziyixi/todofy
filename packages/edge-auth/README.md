# `@ziyixi/edge-auth`

Shared owner authentication compiled into its Worker consumers: Cloudflare Access JWT verification, same-origin JSON mutation checks and the private response
headers. It is TypeScript source with no runtime dependencies (Web Crypto only). It is not a separate
Worker: each app depends on it with `"@ziyixi/edge-auth": "workspace:*"` and its
bundler compiles it in.

[`SPEC.md`](SPEC.md) is the design: the security rules every app gets (§2), the compatibility contracts (§3), which differences between the apps are parameters and
which were unified to the stricter rule (§4), the API (§5) and each app's parameter values and failure
mapping (§5.4). Changing a value an app passes changes that app's behaviour; a new rule becomes a new
parameter reviewed against the §4 table.

```ts
import { createAccessVerifier, verifyCsrf, withPrivateHeaders } from '@ziyixi/edge-auth';

const access = createAccessVerifier(); // module scope: one key cache per isolate
const result = await access.verify(request, policy); // {ok, owner, bypassed} or {ok: false, failure}
// After successful Access authentication, before reading a mutation body:
const mutation = await verifyCsrf(request, { allowedOrigins: ['https://app.example.com'] });
```

The package never reads `env`, never logs and never builds an error body. It returns a typed failure,
and each app maps it to its own status, code and message.

## Checks

```sh
bazel test //packages/edge-auth:check
bazel build //packages/edge-auth
```

The package `check` script invokes the same suite. The typecheck and test scripts also delegate to Bazel. A frozen pnpm workspace install supports source-level development. A consumer declares its package dependency in its BUILD file; public `:check` and `:release`
facades expose those edges to CI. No manual consumer map is maintained.

Source rules (every app's toolchain compiles it, SPEC §6): relative imports end in `.ts`; erasable
TypeScript only (no `enum`, `namespace` or parameter properties); no DOM-only type names; no `Buffer`
and no `crypto.subtle.timingSafeEqual`; state only in objects the app creates.
