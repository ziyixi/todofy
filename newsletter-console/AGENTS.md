# Newsletter console boundaries

Follow root `AGENTS.md`. The console is a read-only owner view of Newsletter, not a second engine or a control plane.

- Newsletter's SQLite database is the record. Notion is only its asynchronous backup: never present it as a source, a
  pipeline stage or a place to edit. The console never writes, runs, sends, retries or syncs anything.
- Owner HTTP uses root `proto/newsletter/ui/v1` through the shared transcoder and client, and shared edge-auth JWT
  verification before anything else. GET and HEAD only; add Origin + CSRF before introducing any mutation (none is
  planned).
- The Worker has no storage bindings and no credential of its own. Its owner identity is Home's, taken by the deploy
  wrapper as exactly `ACCESS_OWNER`/`ACCESS_OWNER_ALIASES`; never let another of Home's values reach it. Upstream it
  sends only the assertion it has just verified, and never logs or echoes it.
- Model, feed and mail text is untrusted: render it as text, link only http and https URLs outside any frame, and
  show mail HTML only in a sandboxed frame with no scripts and no network. `dangerouslySetInnerHTML` is lint-banned.
- Logs carry request IDs, method names, status classes and durations only: never a path value, query, body or token.
- UI: Chinese text, light theme only (no `prefers-color-scheme`), Fleet's warm-paper tokens, every state a shape and a
  word; restrained and simple.
- Synthetic data only in tests; no production inputs. Workers Free; deploy only through the authorized main CI pipeline.
