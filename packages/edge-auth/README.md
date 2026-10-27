# `@ziyixi/edge-auth`

The auth code compiled into every Worker in this repository (the Todofy gateway, Mail Hero and the home
dashboard): Cloudflare Access JWT verification, same-origin JSON mutation checks and the private response
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
cd packages/edge-auth
pnpm install --frozen-lockfile
pnpm run typecheck   # against Todofy's lib set (ES2024) and Mail Hero's (ES2022 + DOM)
pnpm test            # vitest
```

CI runs the same three commands in the `Shared packages` job. Any change in this directory also checks
**and deploys** every app that compiles it in (`PACKAGE_USERS` in `.github/scripts/ci_changes.py`:
Todofy, Mail Hero, the dashboard, the links app, the watch app, Fleet, mailsort, recall, the brief, Tasks, personal-mcp and Model Router); a new app that depends on this package must be
added there, and `test_ci_changes.py` fails until it is.

Source rules (every app's toolchain compiles it, SPEC §6): relative imports end in `.ts`; erasable
TypeScript only (no `enum`, `namespace` or parameter properties); no DOM-only type names; no `Buffer`
and no `crypto.subtle.timingSafeEqual`; state only in objects the app creates.
