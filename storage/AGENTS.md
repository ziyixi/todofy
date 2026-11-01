# Storage

Follow the parent repository rules. Read README.md before changes.

- Only synthetic objects, OAuth responses and credentials in tests. Never log keys, paths, provider responses or tokens.
- Owner routes use edge-auth; machine routes require their independent namespace credential before reading any body.
- Dropbox is a separate App-folder connection. Do not import Recall code, use Recall's connection, or alter its files.
- Every object write is create-only or revision-matched. Keep provider streams bounded; never buffer file contents.
- Provider requests go only to native Dropbox hosts; loopback fakes require the explicit local development bypass.
- Keep namespace/prefix binding on cursors and reject paths that could escape the credential's server-owned prefix.
