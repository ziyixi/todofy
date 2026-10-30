# Personal Cloud

The applications I use to plan work, organize mail, keep a browsing record and follow up on information.
Their code, APIs and infrastructure live in one repository.

[简体中文](README.md) · [Documentation](docs/README.md) · [Deploy and rebuild](docs/rebuild.md)

## Everyday use

| Application | What it does |
| --- | --- |
| [Tasks](tasks/README.md) | Connect Goals to tasks, arrange the week in Plan, work and track time in Focus, and review completion and time spent in GTD. |
| Mail | [Mail Hero](mail-hero/README.md) receives mail, [Mailsort](mailsort/README.md) sorts Gmail by priority, and [Todofy](todofy/README.md) generates summaries. Messages appear in Tasks' Mail view; I choose whether to create an Inbox task from each message. |
| [Recall](recall/README.md) | Keep browsing activity, page text and screenshots; find them through a timeline or full-text search. Older content remains readable from its Dropbox archive. |
| [Watch](watch/README.md) | Monitor page changes and keep text and screenshot evidence for me or an agent to review and follow up. |
| [Newsletter](newsletter/README.md) | Research and review public sources, then build and send the daily newsletter. Its [console](newsletter-console/README.md) shows editions and run records. |
| Website and links | Publish a [personal website](website/README.md) from Notion and manage short links with [Links](links/README.md). |

## Agents and monitoring

- [Personal MCP](personal-mcp/README.md) gives Dots access to Tasks, Mail, Recall and Watch, with work records and event subscriptions for follow-up.
- [Home](dashboard/README.md) shows service health, usage and issues. [Fleet](fleet/README.md) shows VPS workloads, background services and actual release state.

## How it runs

Cloudflare hosts the everyday applications. VPS k3s runs Newsletter, the [Codex Gateway](codex-gateway/README.md) and the [deployment service](platform/README.md).
The [Model Router](model-router/README.md) provides shared model access, request records and usage reporting.

Applications own their data and releases, sharing contracts and a small set of common packages.
[Bazel](docs/bazel.md) pins toolchains and follows declared dependencies to build and test.
GitHub Actions releases affected services; Home and Fleet check the observed runtime state.

See the [architecture](docs/architecture.md) for service boundaries and the [service catalog](docs/service-catalog.md) for all development entrypoints.

## Development

Read [HANDOFF](HANDOFF.md), the [repository rules](AGENTS.md) and the application's README first.
Install the tools described in [workspace setup](docs/dependencies.md).

```sh
bazel build //tasks
bazel test //tasks:check
```

Other applications use the same `//app` and `//app:check` build and test entrypoints.
See [CI/CD](docs/ci-cd.md) for releases and the [documentation guide](docs/README.md) for further reading.
