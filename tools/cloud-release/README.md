# Verified Worker releases

`control.py` selects a source revision, checks the committed configuration against Cloudflare,
and records a successful release after the deployed version and routes pass verification.
CI and drift repair use the same [Worker release workflow](../../.github/workflows/worker-release.yml).
The static website keeps its own content registry and release workflow.

## Release sequence

The workflow holds the app's `*-production` concurrency group throughout these steps:

1. `prepare` accepts the full source SHA from the successful CI caller. For repair, it selects
   the app's latest verified GitHub Deployment; a supplied SHA must equal that record's SHA.
   `--expected-main-sha` additionally checks that the reviewed main revision has not changed.
2. Check out `source_sha` under `.release-source`. Build code, dependencies, Wrangler configs,
   generated resource inventory, and secret declarations come from that checkout.
3. `preflight` reads Cloudflare and reports `clean`, `repairable`, or `manual_required` using
   binding names and fixed reason codes. It compares public variables, service targets,
   schedules, exposure, routes, D1/R2 identity, and recorded Durable Object namespace IDs.
4. When `required=true`, build the selected revision, validate its bundles, run the hostname guard,
   apply the existing app migrations, deploy, and run its production probes. The deploy wrappers
   use `BUILD_SOURCE_SHA` for build identity; a repair can therefore build an older app revision
   while the workflow runs from a newer main revision.
5. `record` reads the provider again, verifies the exact build SHA, configuration, routes, and
   persistent resource identities, then writes a GitHub Deployment and a `success` status.

`prepare` appends `source_sha` to `GITHUB_OUTPUT` and `BUILD_SOURCE_SHA` to `GITHUB_ENV`.
`preflight` appends `required=true|false` to `GITHUB_OUTPUT`. GitHub makes the environment output
available to subsequent steps. `--check-only` always returns `required=false`, so the workflow
skips builds, migrations, deployments, and success records. Local temporary-file cleanup may run.

These are the commands used in separate Actions steps; `RELEASE_SOURCE` in the last two steps
is the first step's selected output:

```sh
python3 tools/cloud-release/control.py prepare --app watch --source-sha "$GITHUB_SHA"
python3 tools/cloud-release/control.py preflight --app watch \
  --source-sha "$RELEASE_SOURCE" --source-root .release-source
# After the app's deployment and production probes succeed:
python3 tools/cloud-release/control.py record --app watch \
  --source-sha "$RELEASE_SOURCE" --source-root .release-source
```

For a repair, pass `--repair` to both `prepare` and `preflight`. For observation only, additionally
pass `--check-only` to `preflight`. Use the workflow to execute the full sequence.

## Inputs and recovery limits

The CLI runs only on `refs/heads/main`. It uses the runner's `GITHUB_REPOSITORY`, `GITHUB_SHA`,
`GITHUB_RUN_ID`, `GITHUB_OUTPUT`, and `GITHUB_ENV`. `GH_TOKEN` authorizes GitHub requests;
`CLOUDFLARE_API_TOKEN` authorizes provider reads during preflight and recording. Deployment
steps use their existing app-specific credentials. Tokens are environment inputs, never CLI arguments.
The current owner pause and maintenance switches remain authoritative during repair.
Normal releases apply the owner's GitHub operational variables. When changing a live switch manually,
update its GitHub variable as documented in the app's runbook; check/repair stops on a mismatch.

`config/cloud.toml` and `config/resources.toml` identify the environment. An old source checkout
cannot repair a different repository, zone, Access issuer, Cloudflare account, or zone ID.
Repair also requires the recorded Wrangler configuration hashes and persistent resource identities
to match. A missing D1 database, R2 bucket, or recorded DO namespace stops the release.
The helper does not restore data or recreate persistent resources.

Missing required secrets, undeclared bindings, changed binding types, changed operational switches,
stateful binding changes, route removal, and hostname ownership conflicts require manual recovery.
Cloudflare returns secret names without their values; these checks cannot recover or verify a secret's
contents. Bootstrap validates complete secret maps separately. Existing releases can retain unreadable
manual secrets when no replacement map is supplied.

Service targets include the Worker name, entrypoint, and environment. If Cloudflare returns service
`props`, the helper compares them exactly; the version and settings APIs can omit this field, so its
absence does not prove an empty object or a configuration change. Configuration hashes record the
declared `props`, and the pinned Wrangler uploads them from the selected configuration. Provider
readback cannot verify their values when the API omits them. [Cloudflare's context documentation](https://developers.cloudflare.com/workers/runtime-apis/context/)
describes `props`, while the [version read schema](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
does not expose that field.

## GitHub records and public receipts

Worker records use `environment=production`, `task=deploy:<app>`, and payload format
`personal-cloud-release-v1`. They contain the verified source SHA, Worker version IDs,
configuration hashes, DO namespace IDs, and public D1/R2 identities. They contain no secret values,
mail, database contents, or private configuration. `record` prints a small receipt containing
`deployment_id`, `app`, `source_sha`, and `verified=true`.

`last_good` inspects the newest 100 app records and accepts the first record of this format whose
latest status is `success`. Failed or legacy records are skipped. This per-app evidence is separate
from CI's cumulative diff base: a documentation commit or a green CI run does not replace the last
successfully deployed revision. Missing verified evidence stops repair; it does not guess a source SHA.

A GitHub record is evidence from the verification performed during that release. It is not a live
health check or a data backup. Later drift must be checked against Cloudflare again. For the VPS,
`vps_record.py` records the daemon's public `ready` receipt with the two verified image digests,
source SHA, release/request IDs, and ETag. Its receipt does not prove restoration of application data.

## Verification

```sh
python3 -m unittest discover -s tools/cloud-release/tests
python3 -m unittest discover -s .github/scripts -p test_worker_release_workflow.py
```

The independent workflow tests read the real CI caller and reusable recipe separately, including
their permissions, source checkout, release locks, check-only guards, and probe-before-record order.
