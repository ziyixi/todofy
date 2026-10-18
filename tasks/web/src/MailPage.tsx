import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Inbox, RefreshCw, Settings } from "lucide-react";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import type {
  MailCategory,
  MailItem,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { MailCategoriesDialog } from "@ziyixi/planning-ui/MailCategories";
import { type Catalog, describeError } from "./api";
import { categoryActions, mailApi } from "./mail-api";
import { Dialog } from "./components/Dialog";
import { MailRow, type MailSummary } from "./components/MailRow";
import "./mail.css";

function Categories({
  catalog,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="dialog native-mail-categories"
      aria-labelledby={heading}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <MailCategoriesDialog
        taskAppName="Tasks"
        headingId={heading}
        labels={catalog.labels.map((label) => ({
          id: label.id,
          name: label.title,
        }))}
        language="en"
        busy={false}
        actions={categoryActions}
        onClose={onClose}
        onSaved={onSaved}
      />
    </dialog>
  );
}

export default function MailPage({
  catalog,
  onTaskCreated,
}: {
  catalog: Catalog;
  onTaskCreated: () => void;
}) {
  const [items, setItems] = useState<MailItem[]>([]);
  const [categories, setCategories] = useState<MailCategory[]>([]);
  const [categoriesEtag, setCategoriesEtag] = useState("");
  const [nextPage, setNextPage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState("");
  const [linkedMail, setLinkedMail] = useState(
    () => new URL(window.location.href).searchParams.get("mail") || "",
  );
  const [summaries, setSummaries] = useState<Map<string, MailSummary>>(
    new Map(),
  );
  const [settings, setSettings] = useState(false);
  const [deletion, setDeletion] = useState<{
    ids: string[];
    requestId: string;
  }>();
  const fileRequests = useRef(
    new Map<string, Parameters<typeof mailApi.convertMailItem>[0]>(),
  );
  const readGeneration = useRef(0);
  const read = useCallback(async (pageToken = "") => {
    const generation = ++readGeneration.current;
    setLoading(true);
    setError("");
    try {
      const result = await mailApi.listMailItems({ pageSize: 50, pageToken });
      if (generation !== readGeneration.current) return;
      setItems((current) =>
        pageToken
          ? [
              ...current,
              ...result.mailItems.filter(
                (item) => !current.some((old) => old.id === item.id),
              ),
            ]
          : result.mailItems,
      );
      setCategories(result.categories);
      setCategoriesEtag(result.categoriesEtag);
      setNextPage(result.nextPageToken);
    } catch (reason) {
      if (generation === readGeneration.current)
        setError(describeError(reason));
    } finally {
      if (generation === readGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void read();
    return () => {
      readGeneration.current += 1;
    };
  }, [read]);
  async function showSummary(item: MailItem) {
    if (expanded === item.id) {
      setExpanded("");
      return;
    }
    setExpanded(item.id);
    if (summaries.get(item.id)?.text !== undefined) return;
    await readSummary(item.id);
  }
  const readSummary = useCallback(async (id: string) => {
    setSummaries((current) => new Map(current).set(id, { loading: true }));
    try {
      const result = await mailApi.readMailSummary({ id });
      setSummaries((current) =>
        new Map(current).set(id, { text: result.summary }),
      );
    } catch (reason) {
      setSummaries((current) =>
        new Map(current).set(id, { error: describeError(reason) }),
      );
    }
  }, []);
  useEffect(() => {
    if (linkedMail) void readSummary(linkedMail);
  }, [linkedMail, readSummary]);
  function closeLinkedSummary() {
    setLinkedMail("");
    const url = new URL(window.location.href);
    url.searchParams.delete("mail");
    window.history.replaceState(window.history.state, "", url);
  }
  async function file(item: MailItem, category?: MailCategory) {
    if (busy) return;
    const request = fileRequests.current.get(item.id) ?? {
      eventId: item.id,
      etag: item.etag,
      requestId: crypto.randomUUID(),
      categoryId: category?.id ?? "",
      categoriesEtag: category ? categoriesEtag : "",
    };
    fileRequests.current.set(item.id, request);
    setBusy(item.id);
    setError("");
    try {
      const result = await mailApi.convertMailItem(request);
      if (!result.task?.id) throw new Error("Unconfirmed task creation");
      setItems((current) => current.filter((value) => value.id !== item.id));
      fileRequests.current.delete(item.id);
      setSummaries((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
      setStatus(item.task ? "Task moved to Inbox." : "Task created in Inbox.");
      onTaskCreated();
    } catch (reason) {
      if (
        reason instanceof RpcStatusError &&
        [400, 409].includes(reason.status.httpStatus)
      )
        fileRequests.current.delete(item.id);
      setError(describeError(reason));
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    if (!deletion || busy) return;
    setBusy("delete");
    setError("");
    try {
      const result = await mailApi.deleteMailSummaries({
        eventIds: deletion.ids,
        requestId: deletion.requestId,
      });
      const deleted = new Set(result.deletedEventIds);
      setItems((current) => current.filter((item) => !deleted.has(item.id)));
      setSummaries(
        (current) => new Map([...current].filter(([id]) => !deleted.has(id))),
      );
      setDeletion(undefined);
      setStatus(
        result.keptEventIds.length
          ? "Some emails changed. Refresh before deleting them."
          : "Mail deleted. Existing tasks were kept.",
      );
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy("");
    }
  }
  const choices = categories.flatMap((category) => {
    const label = catalog.labels.find(
      (value) => value.id === category.label?.externalId,
    );
    return label ? [{ category, label }] : [];
  });
  return (
    <section className="list-view native-mail">
      <header className="view-header">
        <div>
          <h1>Mail</h1>
          <p className="view-subtitle">
            Read first. Create an Inbox task when you need one.
          </p>
        </div>
        <div className="native-mail-toolbar">
          <button
            className="icon-button"
            aria-label="Mail categories"
            disabled={Boolean(busy)}
            onClick={() => setSettings(true)}
          >
            <Settings size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Refresh mail"
            disabled={loading || Boolean(busy)}
            onClick={() => void read()}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="text-button"
            disabled={!items.length || Boolean(busy)}
            onClick={() =>
              setDeletion({
                ids: items.slice(0, 200).map((item) => item.id),
                requestId: crypto.randomUUID(),
              })
            }
          >
            Delete shown
          </button>
        </div>
      </header>
      <p className="native-mail-status" role="status">
        {status}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
          <button className="text-button" onClick={() => void read()}>
            Refresh
          </button>
        </p>
      )}
      {!items.length && loading ? (
        <p className="loading-state">Loading mail…</p>
      ) : !items.length && !error ? (
        <div className="empty-state">
          <Inbox />
          <h2>No mail to review</h2>
          <p>Incoming email stays here until you decide what to do.</p>
        </div>
      ) : null}
      <ul className="native-mail-list">
        {items.map((item) => (
          <MailRow
            key={item.id}
            item={item}
            choices={choices}
            expanded={expanded === item.id}
            summary={summaries.get(item.id)}
            busy={Boolean(busy) || loading}
            saving={busy === item.id}
            pendingCategory={fileRequests.current.get(item.id)?.categoryId}
            onToggle={() => void showSummary(item)}
            onRetrySummary={() => void readSummary(item.id)}
            onFile={(category) => void file(item, category)}
            onDelete={() => {
              setError("");
              setDeletion({ ids: [item.id], requestId: crypto.randomUUID() });
            }}
          />
        ))}
      </ul>
      {nextPage && (
        <button
          className="text-button native-mail-more"
          disabled={loading || Boolean(busy)}
          onClick={() => void read(nextPage)}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      {settings && (
        <Categories
          catalog={catalog}
          onClose={() => setSettings(false)}
          onSaved={() => {
            setSettings(false);
            void read();
            setStatus("Mail categories saved.");
          }}
        />
      )}
      {deletion && (
        <Dialog
          title={`Delete ${deletion.ids.length === 1 ? "email" : `${deletion.ids.length} emails`}?`}
          onClose={() => setDeletion(undefined)}
          className="native-mail-confirm"
        >
          <p>This removes the mail and its summary. Existing tasks stay.</p>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <footer className="dialog-footer">
            <span className="spacer" />
            <button
              className="secondary-button"
              onClick={() => setDeletion(undefined)}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={Boolean(busy)}
              onClick={() => void remove()}
            >
              {busy === "delete" ? "Deleting…" : "Delete mail"}
            </button>
          </footer>
        </Dialog>
      )}
      {linkedMail && (
        <Dialog title="Mail summary" onClose={closeLinkedSummary}>
          <div className="task-edit-main">
            {!summaries.get(linkedMail) ||
            summaries.get(linkedMail)?.loading ? (
              <p role="status">Loading summary…</p>
            ) : summaries.get(linkedMail)?.error ? (
              <p className="error-message" role="alert">
                {summaries.get(linkedMail)?.error}
                <button
                  className="text-button"
                  onClick={() => void readSummary(linkedMail)}
                >
                  Retry summary
                </button>
              </p>
            ) : (
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {summaries.get(linkedMail)?.text || "No summary is available."}
              </div>
            )}
          </div>
          <footer className="dialog-footer">
            <span className="spacer" />
            <button className="secondary-button" onClick={closeLinkedSummary}>
              Close
            </button>
          </footer>
        </Dialog>
      )}
    </section>
  );
}
