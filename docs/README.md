# Documentation guide · 文档导航

Start with the [root README](../README.md) for services and development entry points.
The documents below have different jobs; keep one authoritative home for each fact.

| Need / 想做什么 | Read / 从这里开始 |
| --- | --- |
| Pick up active work / 接手工作 | [HANDOFF](../HANDOFF.md): branches, merge order, remaining verification and owner actions |
| Learn repository rules / 协作规则 | [AGENTS](../AGENTS.md), then the target app's instructions |
| Understand service and data boundaries / 理解边界 | [Architecture](architecture.md) |
| Find declared services / 查询服务声明 | [Service catalog](service-catalog.md) |
| Change a Cloudflare owner API or cross-app contract / 修改接口 | [proto](../proto/README.md) and [contracts](../contracts/README.md); Newsletter's machine/control contracts stay in its app docs |
| Change auth behavior / 修改鉴权 | [edge-auth SPEC](../packages/edge-auth/SPEC.md) |
| Check or release code / 检查与发布 | [CI/CD](ci-cd.md), then the application's runbook |
| Change Cloudflare resources / 修改云资源 | [infra](../infra/README.md) |
| Recreate or recover the cloud / 重建与恢复 | [Rebuild](rebuild.md): current steps; [code audit](rebuild-audit.md): portability gaps, state/secret inventory and proposed improvements |
| Understand older layouts / 查迁移背景 | [History](history.md), including dated old-client compatibility |

## Where facts belong

- **README:** an introduction and useful links, not a deployment manifest or test ledger.
- **AGENTS:** mandatory collaboration, privacy, contract and release constraints; link implementation detail.
- **HANDOFF:** current working state and recorded checks, not a second architecture specification.
- **app.toml + Wrangler:** validated service declarations and committed Cloudflare configuration.
  The catalog references Wrangler hostnames/resources; it does not invent a parallel production configuration.
- **proto + contracts:** the IDL and wire profile, consumer semantics and frozen compatibility evidence.
- **App docs:** current operations and implementation. Verification entries say what was actually tested and when.
- **History:** superseded choices and migration context, clearly labelled so they cannot be mistaken for current behavior.

## Application runbooks

| Service | Development / Design | Operations / Verification |
| --- | --- | --- |
| Mail Hero | [README](../mail-hero/README.md), [AGENTS](../mail-hero/AGENTS.md) | [Setup and recovery](../mail-hero/docs/cloudflare-setup.md), [CI/CD](../mail-hero/docs/ci-cd.md), [verification](../mail-hero/docs/verification-native.md) |
| Todofy | [Development notes](../todofy/docs/dev-notes.md), [gateway contract](../todofy/docs/gateway-contract.md) | [Setup](../todofy/docs/cloudflare-setup.md), [CI/CD](../todofy/docs/ci-cd.md), [verification](../todofy/docs/verification.md) |
| Home | [Current views](../dashboard/docs/design-v2.md), [storage and jobs](../dashboard/docs/design.md) | [Setup](../dashboard/docs/setup.md), [limits](../dashboard/docs/limits.md), [verification](../dashboard/docs/verification.md) |
| Lab | [Design](../lab/docs/design.md), [UX](../lab/docs/ux.md) | [README](../lab/README.md) |
| FlowDay | [Design](../flowday/docs/design.md), [AGENTS](../flowday/AGENTS.md) | [README](../flowday/README.md) |
| Links | [Design](../links/docs/design.md), [AGENTS](../links/AGENTS.md) | [README](../links/README.md) |
| Watch | [Design](../watch/docs/design.md), [AGENTS](../watch/AGENTS.md) | [README](../watch/README.md) |
| Website | [Architecture](../website/docs/architecture.md) | [Release](../website/docs/release.md), [cutover](../website/docs/cutover.md) |
| Newsletter | [README](../newsletter/README.md) | Its independent container release and VPS runbook in `newsletter/` |

Adding or moving a document means updating its incoming links and this guide when relevant.
Do not archive an entire old design while parts still govern storage, recovery, authorization or a compatibility window.
