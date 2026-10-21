import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { mailWords, words } from "./i18n";
import { categoryName, MAX_CATEGORIES } from "./mail";
import type { Language, MailCategories, MailCategory } from "./model";

/** The mail categories Tasks keeps (GetMailCategories, UpdateMailCategories), through the host's transport. */
export interface MailCategoryActions {
  readMailSettings(): Promise<MailCategories>;
  /** Replaces the categories saved with `etag`, none included; answers them as saved. */
  updateMailCategories(
    categories: Omit<MailCategory, "id">[],
    etag: string,
  ): Promise<MailCategories>;
}

interface Props {
  headingId: string;
  /** The labels a category may use, with the names shown. */
  labels: readonly { id: string; name: string }[];
  language: Language;
  busy: boolean;
  actions: MailCategoryActions;
  /** The saved set: the host closes the dialog and says so. */
  onSaved: (saved: MailCategories) => void;
  onClose: () => void;
}

type Draft = Omit<MailCategory, "id"> & { key: number };
const PRIORITIES = [1, 2, 3, 4];

/**
 * The Mail categories dialog: each category is one existing label and a priority (at most four,
 * names generated, none at all is fine). Converting a mail with a category adds them to its task.
 * It reads the categories when it opens; a save writes Tasks alone, and the dialog closes.
 */
export function MailCategoriesDialog({
  headingId,
  labels,
  language,
  busy,
  actions,
  onSaved,
  onClose,
}: Props) {
  const text = words(language);
  const mail = mailWords(language);
  const [saved, setSaved] = useState<MailCategories>();
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const keys = useRef(0);
  const mounted = useRef(true);

  function show(settings: MailCategories) {
    setDrafts(
      settings.categories.map(({ labelId, priority }) => ({
        key: keys.current++,
        labelId,
        priority,
      })),
    );
  }
  useEffect(() => {
    mounted.current = true;
    actions.readMailSettings().then(
      (settings) => {
        if (!mounted.current) return;
        setSaved(settings);
        show(settings);
      },
      () => {
        if (mounted.current) setFailed(true);
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [actions]);

  const known = (id: string) => labels.some((label) => label.id === id);
  function change(key: number, update: Partial<Draft>) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key ? { ...draft, ...update } : draft,
      ),
    );
    setError("");
  }
  function problem(): string {
    if (drafts.some((draft) => !draft.labelId)) return mail.needLabel;
    if (drafts.some((draft) => !known(draft.labelId))) return mail.labelGone;
    const pairs = new Set(
      drafts.map((draft) => `${draft.labelId}:${draft.priority}`),
    );
    if (pairs.size !== drafts.length) return mail.duplicate;
    return "";
  }
  async function save() {
    if (!saved || saving) return;
    const found = problem();
    if (found) return setError(found);
    setSaving(true);
    try {
      const next = await actions.updateMailCategories(
        drafts.map(({ labelId, priority }) => ({ labelId, priority })),
        saved.etag,
      );
      if (mounted.current) onSaved(next);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : text.lastError);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <section className="plus-board-labels plus-mail-categories">
      <header>
        <h2 id={headingId}>{mail.categories}</h2>
        <button className="plus-icon" aria-label={text.close} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p className="plus-muted">{mail.settingsHelp}</p>
      {!saved && !failed && (
        <p className="plus-muted" role="status">
          {mail.settingsLoading}
        </p>
      )}
      {failed && (
        <p className="plus-error" role="alert">
          {mail.settingsFailed}
        </p>
      )}
      {saved && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ul className="plus-mail-category-list">
            {drafts.map((draft, index) => {
              const gone = Boolean(draft.labelId) && !known(draft.labelId);
              const name =
                categoryName(draft, labels) ??
                `${mail.chooseLabel} · P${draft.priority}`;
              return (
                <li key={draft.key}>
                  <select
                    aria-label={`${mail.label} ${index + 1}`}
                    value={gone ? "" : draft.labelId}
                    disabled={saving}
                    onChange={(event) =>
                      change(draft.key, { labelId: event.target.value })
                    }
                  >
                    <option value="" disabled>
                      {mail.chooseLabel}
                    </option>
                    {labels.map((label) => (
                      <option key={label.id} value={label.id}>
                        {label.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`${mail.priority} ${index + 1}`}
                    value={draft.priority}
                    disabled={saving}
                    onChange={(event) =>
                      change(draft.key, {
                        priority: Number(event.target.value),
                      })
                    }
                  >
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>
                        P{priority}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="plus-icon"
                    aria-label={mail.remove(name)}
                    disabled={saving}
                    onClick={() => {
                      setDrafts((current) =>
                        current.filter((item) => item.key !== draft.key),
                      );
                      setError("");
                    }}
                  >
                    <X size={16} />
                  </button>
                  {gone && <p className="plus-warning">{mail.labelGone}</p>}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="plus-text-button plus-mail-category-add"
            disabled={saving || drafts.length >= MAX_CATEGORIES}
            title={drafts.length >= MAX_CATEGORIES ? mail.addLimit : undefined}
            onClick={() => {
              setDrafts((current) => [
                ...current,
                { key: keys.current++, labelId: "", priority: 4 },
              ]);
              setError("");
            }}
          >
            <Plus size={13} />
            {mail.add}
          </button>
          {error && (
            <p role="alert" className="plus-error">
              {error}
            </p>
          )}
          <footer>
            <button
              className="plus-button plus-primary"
              disabled={busy || saving}
            >
              {text.save}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
