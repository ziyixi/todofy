import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { validOrigin } from "./api";
import type { Result } from "./messages";
export function Options() {
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void browser.runtime
      .sendMessage({ kind: "connection" })
      .then((result: Result<{ connected: boolean; apiOrigin: string }>) => {
        if (result.ok) {
          setOrigin(result.value.apiOrigin);
          setConnected(result.value.connected);
        }
      });
  }, []);
  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const apiOrigin = validOrigin(origin);
      // Optional host access is requested from this explicit user click, for this one origin.
      if (!(await browser.permissions.request({ origins: [`${apiOrigin}/*`] })))
        throw new Error("Allow access to your Todofy API to connect.");
      const result = (await browser.runtime.sendMessage({
        kind: "connect",
        connection: { apiOrigin, token },
      })) as Result;
      if (!result.ok) throw new Error(result.error);
      setToken("");
      setConnected(true);
      setMessage("Connection saved. Open Todoist and refresh the page.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Connection could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="plus-root" style={{ maxWidth: 620, margin: "30px auto" }}>
      <h1>Todoist Plus</h1>
      <p className="plus-muted">
        Open your Todofy owner page at <code>/plus</code>, confirm the label
        mapping, and create an extension connection. Copy its API origin and
        one-time token here.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        style={{ display: "grid", gap: 15, marginTop: 30 }}
      >
        <label>
          API origin
          <input
            style={{ display: "block", width: "100%", marginTop: 5 }}
            type="url"
            autoComplete="url"
            placeholder="https://your-todofy-hooks.example"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            required
          />
        </label>
        <label>
          Connection token
          <input
            style={{ display: "block", width: "100%", marginTop: 5 }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
        </label>
        <div>
          <button
            className="plus-button plus-primary"
            disabled={busy || !token}
          >
            {busy ? "Saving…" : connected ? "Replace connection" : "Connect"}
          </button>
          {connected && (
            <button
              style={{ marginLeft: 12 }}
              type="button"
              className="plus-button"
              disabled={busy}
              onClick={() =>
                void browser.runtime
                  .sendMessage({ kind: "disconnect" })
                  .then(() => {
                    setConnected(false);
                    setMessage(
                      "Disconnected on this browser. Revoke the token in Todofy to disable it everywhere.",
                    );
                  })
              }
            >
              Disconnect
            </button>
          )}
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      <p className="plus-muted" style={{ marginTop: 35 }}>
        The extension keeps the connection token in its background storage.
        Todoist’s page never receives it. Your existing Todoist labels and
        filters remain available when the extension is disabled.
      </p>
    </main>
  );
}
