# Workspace dependencies

The monorepo has one Node workspace and one Python workspace. Applications keep their own code,
dependency selection, images and release scope; shared versions and resolution live at the repository root.

| Ecosystem | Version source | Lock | Runtime |
| --- | --- | --- | --- |
| Node | `package.json` and the catalog in `pnpm-workspace.yaml` | `pnpm-lock.yaml` | Node 26, pnpm 11.25.0 |
| Python | Root `pyproject.toml` constraints and dependency groups | `uv.lock` | `.python-version`, Python 3.14 |

Member Node manifests use `catalog:` for external dependencies and `workspace:*` for internal packages.
Python members declare the dependencies and extras they actually need; exact common versions are root constraints.
The official Codex Python SDK pins its corresponding CLI runtime in the VPS executor. Newsletter uses the
shared provider-neutral Model Router client and installs no SDK or CLI of its own.
Do not create member `package-lock.json`, `pnpm-lock.yaml` or `uv.lock` files.

## Install and run

Run dependency installation from the repository root:

```sh
uv python install
pnpm install --frozen-lockfile
uv sync --locked --all-packages --all-extras
```

Normal application scripts retain their application working directories. For example:

```sh
pnpm --dir mailsort/worker run test
pnpm --dir mailsort/web run build
uv run --locked --package personal-newsletter newsletter --help
```

CI installs the required workspace selection from these same frozen locks. Python's protobuf build backend
uses the root toolchain and the interpreter selected by `.python-version`; it does not recursively invoke
`uv run` while generating its own package.

## Update a dependency

For Node, edit the root catalog entry and run `pnpm install` to update the shared lock.
For Python, edit the root constraint and run `uv lock`. Review the lock diff and run the affected checks.
Keep package dependency choices in their member manifests instead of installing every dependency into every image.

Shared-lock and toolchain changes reach the corresponding applications in CI and release source selection.
Each production image is still built, tested and published independently. The running service version is
verified from its normal release receipt and actual workload state, not from a lockfile alone.
