# Personal MCP

Read the root AGENTS, this app's README and docs/connection.md.

- The real Dots OAuth/synthetic-event gate passed on `422df6a0`; business behavior needs its own acceptance.
  Keep this a small personal integration: one Worker, the existing SQLite DO and existing source APIs.
- Access owns OAuth. Reuse edge-auth for its injected assertion; never turn browser cookies into credentials.
  Callback URLs and webhook secrets must not appear in logs or status. Preserve the existing private App identity.
- Use the official MCP SDK and Zod for the external protocol, root proto/generated clients for private bindings.
  Do not import other applications or create arbitrary RPC dispatch tools.
- Tasks, Mail, Recall and Home own their data. Poll only active subscription sources, at most once per minute.
  Initial baselines skip history. Commit frozen deliveries with cursor progress; stop polling after unsubscribe.
  Confirmed MCP task revisions are suppressed; Home events exclude MCP's own attention to prevent a loop.
- `accepted` means ChatGPT acknowledged a webhook, not that a Dot completed its action. Home must expose real
  callback/source failures; use its existing dismissal behavior, not permanent new warning state.
- Use native receipts, etags and stable Step identities. Inbox/Step automation needs an explicit owner responsibility;
  dates, commitments, completion and deletion need owner instructions. Queue moves preserve dates and deadlines.
- Dot-facing rules (when to register Work, resumption, checkpoints and reports, schedules, Watch reviews, cleanup)
  have one source: `plugin/skills/personal-cloud/SKILL.md` plus the tool descriptions. Change them there; other
  docs point to them.
- Work memory belongs in the existing SQLite DO, with only `active`, `waiting`, `done`, `cancelled`. Business facts
  stay in their source; refs link Task, Codex, Watch, Recall, schedule and artifact identities. A checkpoint is silent;
  only a report requests a Work notification. `done` refuses unhandled reports, and a finished Work needs its owned
  Watch, schedule and Codex links confirmed stopped or completed. `review_at` is a hint, not a scheduler, and MCP does
  not wake local Codex.
- MCP-created work Watches must link to a Work and default to `NONE`, without creating a Tasks item. Preserve
  an existing shared Watch's notification settings. Creation confirms the owned link; pause/resume require the
  current Watch etag and a current source read confirms a stop, beyond a frozen mutation receipt. Watch evidence and
  health reach linked open Works as reports from the private feed; an expired cursor becomes one gap report per Work.
  A Dot's judgment never alters a Watch baseline or creates permanent ignore rules.
- Recall activity is a bounded timeline read. `recall_read` retains its text-only behavior; `recall_view` must
  return a real MCP image content block when an image is available. Do not treat a base64 string as a viewed image.
- Tests use synthetic content and local receivers. Do not read real task, mail or browsing content to test a tool.
  Do not add a generic event bus, replay service, compensation framework or extra scheduling infrastructure.
- Release by branch CI and the same-SHA main Actions path. Deploy private source entrypoints before binding them.
  Keep local, deployed, callback-accepted and actual Dots behavior separate in the verification record.
