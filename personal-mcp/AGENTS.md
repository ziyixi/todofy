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
- Work memory belongs in the existing SQLite DO. Register only work that crosses turns, waits, runs in the
  background or has a later delegation. Keep its goal, authorized scope, completion condition, continuation
  summary, next action and waiting/follow-up facts current. Use only `active`, `waiting`, `done`, `cancelled`.
  Business facts still belong to their source; refs link Task, Codex, Watch, Recall, schedule and artifact identities.
- On resumption read Work context, then the Work and relevant current sources. Checkpoint before external
  effects and save the receipt or observed result afterward. A checkpoint is silent; only a report requests a
  Work notification. Callback acceptance never proves completion. `review_at` is a review hint, not a scheduler.
- `owned` marks only resources dedicated to that Work. Before closing or cancelling it, stop its real owned
  Watch/schedule and confirm the result; keep shared resources running. Store a native schedule ID only after
  creating it successfully. Reuse Dots' native schedules and existing Codex chats; MCP does not wake local Codex.
- MCP-created work Watches must link to a Work and default to `NONE`, without creating a Tasks item. Preserve
  an existing shared Watch's notification settings. Creation confirms the owned link; pause/resume require the
  current Watch etag and a current source read confirms a stop, beyond a frozen mutation receipt. Watch rules
  produce candidates; the Dot judges relevance
  to the Work goal from bounded before/after evidence and checkpoints a `watch_review` entry with the real
  `change_ref`, `verdict` (`relevant`, `irrelevant`, `uncertain`) and `reason`. Missing, truncated or failed
  evidence cannot support `irrelevant`. A judgment does not alter a Watch baseline or create permanent ignore
  rules. Check the initial state before waiting for another change.
- Recall activity is a bounded timeline read. `recall_read` retains its text-only behavior; `recall_view` must
  return a real MCP image content block when an image is available. Do not treat a base64 string as a viewed image.
- Tests use synthetic content and local receivers. Do not read real task, mail or browsing content to test a tool.
  Do not add a generic event bus, replay service, compensation framework or extra scheduling infrastructure.
- Release by branch CI and the same-SHA main Actions path. Deploy private source entrypoints before binding them.
  Keep local, deployed, callback-accepted and actual Dots behavior separate in the verification record.
