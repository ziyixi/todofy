import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { RefreshCw, Settings } from "lucide-react";
import { useAnnouncement } from "./announce";
import { displayedTitle, todoistProjectUrl, todoistTaskUrl } from "./domain";
import { mailWords, words } from "./i18n";
import {
  categoryLabels,
  categoryName,
  categoryParts,
  deletionBatch,
  MAX_CATEGORIES,
  mailboxCandidates,
  mailboxRows,
  mailTime,
  recheckedBatch,
  rowName,
  summaryParagraphs,
  touched,
  type MailRow,
} from "./mail";
import { MailCategoriesDialog } from "./MailCategories";
import { pendingTask } from "./plan-updates";
import { PendingMark } from "./StatusMarks";
import type {
  Language,
  MailCategories,
  MailCategory,
  MailDeletion,
  MailItem,
  PlanningTask,
  PlusActions,
  PlusData,
  RunOperation,
} from "./model";

interface Props {
  /** The plan, the day queues and the timer; undefined until the first read. */
  data?: PlusData;
  /** When `data` was last read in full: each new read asks Todofy about the mail again. */
  readAt: number;
  language: Language;
  /** Writes wait: another confirm-first write, a remembered snapshot, setup or maintenance. */
  busy: boolean;
  /** Cards with a write not yet confirmed. */
  pending: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  /** App is reading or writing. */
  refreshing: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  /** App's error and setup lines, shown under the header. */
  notices: ReactNode;
  /** Whether `notices` holds an error, which takes the loading line's place. */
  failed: boolean;
}

/** What Todofy said about the mail project tasks of one complete read, and the categories. */
interface Lookup {
  readAt: number;
  /** Every task asked about: its mail item, or null when no Mail Hero event created it. */
  items: ReadonlyMap<string, MailItem | null>;
  categories: MailCategories;
}
/** A category the rows offer, whose label still exists, with its name and the two parts of it. */
interface Choice {
  category: MailCategory;
  name: string;
  label: string;
  priority: string;
}
/** Delete all's frozen batch, from the confirmation's opening to its end. */
interface Deletion {
  taskIds: string[];
  /** Titles of the listed mail kept because the owner changed or planned it. */
  kept: string[];
  later: number;
  requestId: string;
  state: "confirm" | "deleting" | "failed";
  /** Mail touched since the confirmation opened left the batch: the new count is read out. */
  shrank?: boolean;
}
type Summary =
  { state: "loading" | "failed" } | { state: "done"; text: string };

/**
 * Plus's Mailbox: the mail Todofy turned into tasks that is still to clarify, newest first, as a
 * quiet list of title, brief and time. A row expands in place to the full Todofy summary (plain
 * text); its filing buttons, one per category and Inbox, show on hover or focus and file at one
 * click, always into the Todoist Inbox. Delete all permanently deletes the untouched mail listed
 * when its confirmation opened. Mail text stays in this page's memory.
 */
export function Mailbox({
  data,
  readAt,
  language,
  busy,
  pending,
  run,
  actions,
  refreshing,
  onRefresh,
  onSettings,
  notices,
  failed,
}: Props) {
  const text = words(language);
  const mail = mailWords(language);
  const plan = data?.plan;
  const [lookup, setLookup] = useState<Lookup>();
  const [lookupFailed, setLookupFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const asked = useRef(0);
  const [active, setActive] = useState("");
  const [expanded, setExpanded] = useState("");
  const [summaries, setSummaries] = useState<ReadonlyMap<string, Summary>>(
    new Map(),
  );
  // What the last write did (filed, deleted, the categories saved): shown, and read out, until the
  // next result replaces it. Its line is always there, so neither moves the list.
  const [status, setStatus] = useAnnouncement();
  const [dialog, setDialog] = useState<"categories" | "delete">();
  const [deletion, setDeletion] = useState<Deletion>();
  const [focusAt, setFocusAt] = useState<number>();
  const fileRequests = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const emptyLine = useRef<HTMLParagraphElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The header's Mail categories button, which opens them and takes focus when they close.
  const gearRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  const candidates = useMemo(
    () => (plan ? mailboxCandidates(plan) : []),
    [plan],
  );
  const candidateKey = candidates.map((task) => task.id).join(",");
  const { rows, others } = useMemo(
    () => mailboxRows(candidates, lookup?.items ?? new Map()),
    [candidates, lookup],
  );
  const labels = useMemo(
    () =>
      plan
        ? categoryLabels(plan, { work: text.work, personal: text.personal })
        : [],
    [plan, text.work, text.personal],
  );
  const categories = lookup?.categories;
  // A category whose label is gone is not offered.
  const usable: Choice[] = (categories?.categories ?? [])
    .flatMap((category) => {
      const name = categoryName(category, labels);
      const parts = categoryParts(category, labels);
      return name && parts ? [{ category, name, ...parts }] : [];
    })
    .slice(0, MAX_CATEGORIES);
  const isTouched = (task: PlanningTask) =>
    data
      ? touched(task, {
          tasks: data.plan.tasks,
          days: data.days,
          focus: data.focus,
          pending,
          dependencies: data.plan.dependencies,
        })
      : true;
  const deletable = rows.filter((row) => !isTouched(row.task));
  const activeId = rows.some((row) => row.task.id === active)
    ? active
    : (rows[0]?.task.id ?? "");

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  // Each complete read asks about every candidate again; a task new since then, about it alone.
  useEffect(() => {
    if (!plan?.inboxProjectId) return;
    const fresh = lookup?.readAt !== readAt;
    const ids = candidates
      .map((task) => task.id)
      .filter((id) => fresh || !lookup?.items.has(id));
    if (!fresh && !ids.length) return;
    const request = ++asked.current;
    setAsking(true);
    actions.lookupMail(ids).then(
      (answer) => {
        if (request !== asked.current) return;
        setLookup((current) => {
          const items = new Map(fresh || !current ? [] : current.items);
          for (const id of ids) items.set(id, null);
          for (const item of answer.items) items.set(item.taskId, item);
          const { categories, etag } = answer;
          return { readAt, items, categories: { categories, etag } };
        });
        setLookupFailed(false);
        setAsking(false);
      },
      () => {
        if (request !== asked.current) return;
        setLookupFailed(true);
        setAsking(false);
      },
    );
    // candidateKey stands for candidates; lookup is compared, not followed.
  }, [readAt, candidateKey, plan?.inboxProjectId, lookup, actions]);
  useEffect(() => {
    if (dialog && dialogRef.current && !dialogRef.current.open)
      dialogRef.current.showModal();
    if (dialog === "delete") cancelRef.current?.focus();
  }, [dialog]);
  // After a row leaves, focus goes to the row now in its place, or to the empty line, unless the
  // owner has moved on elsewhere meanwhile.
  useEffect(() => {
    if (focusAt === undefined) return;
    setFocusAt(undefined);
    const root = list.current?.getRootNode() as
      Document | ShadowRoot | undefined;
    const current = root?.activeElement;
    const page = heading.current?.closest(".plus-mailbox");
    if (current && current !== document.body && !page?.contains(current))
      return;
    const buttons = rowButtons();
    const target = buttons[Math.min(focusAt, buttons.length - 1)];
    if (target) {
      setActive(rows[Math.min(focusAt, rows.length - 1)]?.task.id ?? "");
      target.focus();
    } else emptyLine.current?.focus();
  }, [focusAt, rows]);

  function rowButtons() {
    return [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        ".plus-mailbox-row",
      ) ?? []),
    ];
  }
  function moveTo(index: number) {
    const at = Math.max(0, Math.min(index, rows.length - 1));
    const row = rows[at];
    if (!row) return;
    setActive(row.task.id);
    rowButtons()[at]?.focus();
  }
  function rowKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      j: index + 1,
      ArrowUp: index - 1,
      k: index - 1,
      Home: 0,
      End: rows.length - 1,
    };
    if (event.key in moves && !event.altKey && !event.metaKey) {
      event.preventDefault();
      moveTo(moves[event.key]!);
    } else if (event.key === "Escape" && expanded === rows[index]?.task.id) {
      event.preventDefault();
      setExpanded("");
    }
  }
  function toggle(row: MailRow) {
    setActive(row.task.id);
    if (expanded === row.task.id) return setExpanded("");
    setExpanded(row.task.id);
    const known = summaries.get(row.mail.id);
    if (!row.mail.hasSummary || (known && known.state !== "failed")) return;
    const show = (summary: Summary) =>
      setSummaries((current) => new Map(current).set(row.mail.id, summary));
    show({ state: "loading" });
    // A summary that cannot be read shows the brief and says so; opening it again tries again.
    actions.readMailSummary(row.mail.id).then(
      (summary) => show({ state: "done", text: summary }),
      () => show({ state: "failed" }),
    );
  }
  /** Files a mail into the Todoist Inbox, with a category's label and priority if one is given. */
  async function file(row: MailRow, choice?: Choice) {
    if (!categories) return;
    // The task's etag, and a category's etag, are part of the key: once either changed, so that
    // Todofy refuses the old request, the read that follows makes the next click a new one.
    const key = [
      row.task.id,
      row.task.etag,
      choice ? `${choice.category.id}:${categories.etag}` : "inbox",
    ].join("|");
    const requestId = fileRequests.current.get(key) ?? crypto.randomUUID();
    fileRequests.current.set(key, requestId);
    const index = rows.indexOf(row);
    const title = displayedTitle(row.task.title);
    // Confirm-first: the row waits, dimmed, and leaves once Todoist has the change.
    const confirmed = await run(
      async () => {
        const task = await actions.fileMail(
          row.task,
          choice?.category,
          categories.etag,
          requestId,
        );
        fileRequests.current.delete(key);
        return task;
      },
      { pending: [pendingTask(row.task.id)] },
    );
    // Focus goes to the row now in its place, or back to this one when it stays; App's error
    // line says when the filing was not saved.
    setFocusAt(index);
    if (confirmed)
      setStatus(
        choice ? mail.filed(choice.name, title) : mail.movedInbox(title),
      );
  }
  function openDeletion() {
    const batch = deletionBatch(rows, isTouched);
    if (!batch.taskIds.length) return;
    setDeletion({
      taskIds: batch.taskIds,
      kept: batch.kept.map((row) => displayedTitle(row.task.title)),
      later: batch.later,
      requestId: crypto.randomUUID(),
      state: "confirm",
    });
    setDialog("delete");
  }
  async function confirmDeletion() {
    if (!deletion || deletion.state === "deleting" || !data) return;
    // Only ever smaller: a mail touched meanwhile leaves the batch, and the new count is shown
    // before anything is sent, under a new request (Todofy fingerprints the IDs).
    const now = recheckedBatch(deletion.taskIds, data.plan.tasks, isTouched);
    if (now.taskIds.length < deletion.taskIds.length) {
      const kept = [
        ...deletion.kept,
        ...now.touched.map((task) => displayedTitle(task.title)),
      ];
      if (!now.taskIds.length) {
        dialogRef.current?.close();
        setStatus(mail.deletedSome(0, now.touched.length));
        return;
      }
      setDeletion({
        ...deletion,
        taskIds: now.taskIds,
        kept,
        requestId: crypto.randomUUID(),
        state: "confirm",
        shrank: true,
      });
      return;
    }
    const frozen = deletion;
    setDeletion({ ...frozen, state: "deleting" });
    let result: MailDeletion | undefined;
    const done = await run(
      async () => {
        result = await actions.deleteMail(frozen.taskIds, frozen.requestId);
        return result;
      },
      { pending: frozen.taskIds.map(pendingTask) },
    );
    if (!done || !result) {
      // Try again sends the same request, which finishes the rest: Todofy froze its deletions on
      // the first try and reads them again, so it never deletes one twice or one changed since.
      setDeletion({ ...frozen, state: "failed" });
      return;
    }
    const kept = result.keptTaskIds.length;
    setStatus(
      kept
        ? mail.deletedSome(result.deletedTaskIds.length, kept)
        : mail.deleted(result.deletedTaskIds.length),
    );
    dialogRef.current?.close();
    setFocusAt(0);
  }
  function closeDialog() {
    const categoriesClosed = dialog === "categories";
    setDialog(undefined);
    setDeletion(undefined);
    if (categoriesClosed) gearRef.current?.focus();
  }

  const spinning = refreshing || asking;
  const shown = Boolean(plan?.inboxProjectId && lookup && !lookupFailed);
  return (
    <div className="plus-mailbox">
      <header className="plus-page-header">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            {text.mailbox}
          </h1>
          {shown && rows.length > 0 && (
            <div className="plus-subtitle">{mail.count(rows.length)}</div>
          )}
        </div>
        <p className="plus-mailbox-status" role="status">
          {status}
        </p>
        <div className="plus-header-actions">
          {shown && deletable.length > 0 && (
            <button
              className="plus-mailbox-delete-all"
              disabled={busy || !plan?.configured}
              onClick={openDeletion}
            >
              {mail.deleteAll}
            </button>
          )}
          <button
            className="plus-icon"
            aria-label={text.refresh}
            title={text.refresh}
            // The read that follows asks about the mail again; its answer clears a failure.
            onClick={onRefresh}
          >
            <RefreshCw size={17} className={spinning ? "plus-spin" : ""} />
          </button>
          <button
            ref={gearRef}
            className="plus-icon"
            aria-label={mail.categories}
            title={mail.categories}
            disabled={!plan?.configured}
            onClick={() => setDialog("categories")}
          >
            <Settings size={17} />
          </button>
        </div>
      </header>
      {notices}
      {plan && !plan.inboxProjectId && (
        <p className="plus-empty">{mail.noProject}</p>
      )}
      {plan?.inboxProjectId && lookupFailed && (
        <div className="plus-error" role="alert">
          <span>{mail.failed}</span>
          <button onClick={onRefresh}>{text.refresh}</button>
          <button onClick={onSettings}>{text.manage}</button>
        </div>
      )}
      {((!plan && !failed) ||
        (plan?.inboxProjectId && !lookup && !lookupFailed)) && (
        <p className="plus-muted" role="status">
          {mail.loading}
        </p>
      )}
      {shown && data && (
        <fieldset
          className="plus-content-fieldset"
          disabled={!data.plan.configured}
        >
          <span id={hintId} className="plus-sr-only">
            {mail.hint}
          </span>
          {rows.length > 0 ? (
            <ul
              className="plus-mailbox-list"
              aria-label={text.mailbox}
              ref={list}
            >
              {rows.map((row, index) => {
                const title = displayedTitle(row.task.title);
                const time = mailTime(
                  row.mail.receivedAt,
                  data.plan.timezone,
                  data.focus.date,
                  language,
                );
                const open = expanded === row.task.id;
                const summary = summaries.get(row.mail.id);
                // The summary takes the brief's place only while its row is open.
                const paragraphs =
                  open && summary?.state === "done"
                    ? summaryParagraphs(summary.text)
                    : [];
                const note =
                  summary?.state === "loading"
                    ? mail.summaryLoading
                    : summary?.state === "failed"
                      ? mail.summaryFailed
                      : paragraphs.length
                        ? ""
                        : mail.summaryGone;
                const waits = pending.has(pendingTask(row.task.id));
                const current = row.task.id === activeId;
                // One click files: by a category, or into the Inbox alone.
                const fileButton = (choice?: Choice) => {
                  const name = choice
                    ? mail.fileAs(choice.name, title)
                    : mail.moveInbox(title);
                  return (
                    <button
                      key={choice?.category.id ?? "inbox"}
                      className="plus-mailbox-action"
                      aria-label={name}
                      title={name}
                      tabIndex={current ? 0 : -1}
                      disabled={busy}
                      onFocus={() => setActive(row.task.id)}
                      onClick={() => void file(row, choice)}
                    >
                      {choice ? (
                        <>
                          <span className="plus-mailbox-action-label">
                            {choice.label}
                          </span>
                          <span className="plus-mailbox-action-priority">
                            {` · ${choice.priority}`}
                          </span>
                        </>
                      ) : (
                        mail.inbox
                      )}
                    </button>
                  );
                };
                return (
                  <li
                    key={row.task.id}
                    data-mail-task={row.task.id}
                    className={[
                      "plus-mailbox-item",
                      open && "is-open",
                      waits && "is-pending",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      className="plus-mailbox-row"
                      aria-expanded={open}
                      aria-label={rowName(row, time.short, language)}
                      aria-describedby={hintId}
                      tabIndex={current ? 0 : -1}
                      onFocus={() => setActive(row.task.id)}
                      onClick={() => toggle(row)}
                      onKeyDown={(event) => rowKeys(event, index)}
                    >
                      <span className="plus-mailbox-title">{title}</span>
                      {row.mail.brief && !paragraphs.length && (
                        <span className="plus-mailbox-brief">
                          {row.mail.brief}
                        </span>
                      )}
                    </button>
                    {open && (
                      <div
                        className="plus-mailbox-detail"
                        role="region"
                        aria-label={title}
                      >
                        {paragraphs.length > 0 && (
                          <div className="plus-mailbox-summary">
                            {paragraphs.map((lines, at) => (
                              <p key={at}>
                                {lines.map((line, number) => (
                                  <span key={number}>
                                    {number > 0 && <br />}
                                    {line}
                                  </span>
                                ))}
                              </p>
                            ))}
                          </div>
                        )}
                        <p className="plus-mailbox-meta">
                          {note && <span>{note} </span>}
                          {summary?.state !== "loading" && (
                            <>
                              {mail.received(time.full)} ·{" "}
                              <a href={todoistTaskUrl(row.task.id)}>
                                {text.open}
                              </a>
                            </>
                          )}
                        </p>
                      </div>
                    )}
                    <span className="plus-mailbox-side">
                      {/* The row's name says the time already. */}
                      <time
                        className="plus-mailbox-time"
                        dateTime={row.mail.receivedAt}
                        title={time.full}
                        aria-hidden="true"
                      >
                        {time.short}
                      </time>
                      {waits ? (
                        <PendingMark language={language} />
                      ) : (
                        // The categories in their saved order, then Inbox at the right edge.
                        <span className="plus-mailbox-actions">
                          {usable.map((choice) => fileButton(choice))}
                          {fileButton()}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="plus-empty" tabIndex={-1} ref={emptyLine}>
              {mail.empty}
            </p>
          )}
          {others > 0 && (
            <p className="plus-mailbox-footer">
              {mail.others(others)} ·{" "}
              <a href={todoistProjectUrl(data.plan.inboxProjectId)}>
                {text.open}
              </a>
            </p>
          )}
        </fieldset>
      )}
      <dialog
        ref={dialogRef}
        className={
          dialog === "delete"
            ? "plus-dialog plus-confirm-dialog"
            : "plus-dialog"
        }
        aria-labelledby={dialog ? `${hintId}-dialog` : undefined}
        // A permanent deletion's warning, and what it keeps, are read out with its title.
        aria-describedby={
          dialog === "delete" && deletion
            ? [
                `${hintId}-body`,
                deletion.kept.length > 0 && `${hintId}-kept`,
                deletion.later > 0 && `${hintId}-later`,
              ]
                .filter(Boolean)
                .join(" ")
            : undefined
        }
        onCancel={(event) => {
          // Esc cancels, but never a deletion on its way.
          if (deletion?.state === "deleting") event.preventDefault();
        }}
        onClose={closeDialog}
      >
        {dialog === "delete" && deletion && (
          <section className="plus-confirm">
            <h2 id={`${hintId}-dialog`}>
              {mail.confirmTitle(deletion.taskIds.length)}
            </h2>
            <p id={`${hintId}-body`}>
              {mail.confirmBody(deletion.taskIds.length)}
            </p>
            {deletion.kept.length > 0 && (
              <p id={`${hintId}-kept`} className="plus-muted">
                {mail.confirmKept(deletion.kept)}
              </p>
            )}
            {deletion.later > 0 && (
              <p id={`${hintId}-later`} className="plus-muted">
                {mail.confirmLimit}
              </p>
            )}
            <p className="plus-sr-only" role="status">
              {deletion.shrank
                ? mail.confirmTitle(deletion.taskIds.length)
                : ""}
            </p>
            {deletion.state === "failed" && (
              <p role="alert">{mail.deleteFailed}</p>
            )}
            <footer>
              <button
                ref={cancelRef}
                className="plus-button"
                disabled={deletion.state === "deleting"}
                onClick={() => dialogRef.current?.close()}
              >
                {text.cancel}
              </button>
              <button
                className="plus-button"
                disabled={deletion.state === "deleting"}
                onClick={() => void confirmDeletion()}
              >
                {deletion.state === "deleting"
                  ? mail.deleting
                  : deletion.state === "failed"
                    ? text.retry
                    : mail.deleteN(deletion.taskIds.length)}
              </button>
            </footer>
          </section>
        )}
        {dialog === "categories" && plan && (
          <MailCategoriesDialog
            headingId={`${hintId}-dialog`}
            labels={labels}
            language={language}
            busy={busy || !plan.configured}
            actions={actions}
            onSaved={(saved) => {
              setLookup(
                (current) => current && { ...current, categories: saved },
              );
              dialogRef.current?.close();
              setStatus(mail.saved);
            }}
            onClose={() => dialogRef.current?.close()}
            onConnection={onSettings}
          />
        )}
      </dialog>
    </div>
  );
}
