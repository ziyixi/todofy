# Personal MCP

Read the root AGENTS, this app's README and docs/connection.md.

- Keep the first gate limited to real Dots OAuth and one synthetic event. Do not add business bindings before
  that gate is accepted. The user explicitly prioritizes a small personal implementation.
- OAuth is owned by the new Access application only. Reuse edge-auth to validate its injected assertion; never
  turn browser cookies into machine credentials. Callback URLs and webhook secrets must not appear in logs.
- MCP protocol uses the official SDK and Zod; it is an external protocol, not a second owner JSON API.
  Internal business interfaces added later use the root proto and existing service boundaries.
- Use only synthetic content in tests. The first gate must not read or alter Tasks, Mail or Recall records.
- `accepted` means ChatGPT acknowledged a webhook, not that a Dot completed its action.
- Tests should demonstrate discovery, persistent subscriptions, signed delivery and no duplicate test actions.
  Do not build a generic event bus, replay service, compensation system or broad compatibility framework.
- Release through the repository CI and infra workflow. Keep real connection evidence separate from local tests.
