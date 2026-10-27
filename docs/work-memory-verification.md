# Work-memory verification

Work memory, the Work tools and the Work Watch feed shipped on 2026-10-22 in the
[same-SHA main release](https://github.com/ziyixi/todofy/actions/runs/39779693261) (Watch, Recall, Personal MCP and
Home only). What it showed, with synthetic Work and a public test page only:

- Work records, checkpoints and reports stay in the existing SQLite DO. Exact retries and report IDs are idempotent;
  a checkpoint is silent and only a report requests `work.attention`.
- After **Refresh tools** and a Reboot of the existing Dot (conversations, memories and schedules kept), a real Dot
  created a Work and a dedicated `NONE` Watch, resumed from a real `work.attention` event, checkpointed the handled
  report silently and stopped its owned Watch before closing the Work. A callback's `accepted` alone was not the evidence.
- `recall_view` returned real MCP image content that the Dot described.

Not observed in that pass: a natural run of the hourly Work review and a production webpage change. The current rules
are the [skill](../personal-mcp/plugin/skills/personal-cloud/SKILL.md) and the tool descriptions.
