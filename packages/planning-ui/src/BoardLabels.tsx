import { useState } from "react";
import { Settings, X } from "lucide-react";
import type { Language, PlanState } from "./model";
import { words } from "./i18n";

type Binding = PlanState["managedLabels"][number];
const ROLES = ["quarter", "candiate", "focus", "committed"] as const;

interface Props {
  taskAppName?: string;
  plan: PlanState;
  language: Language;
  busy: boolean;
  onSave: (labels: Binding[]) => Promise<boolean>;
  onClose: () => void;
  onConnection: () => void;
}

export function BoardLabels({
  taskAppName = "Todoist",
  plan,
  language,
  busy,
  onSave,
  onClose,
  onConnection,
}: Props) {
  const text = words(language, taskAppName);
  const titles = {
    quarter: text.quarterly,
    candiate: text.monthly,
    focus: language === "zh" ? "本周待选" : "This week",
    committed: text.committed,
  };
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      ROLES.map((role) => [
        role,
        plan.managedLabels.find((label) => label.role === role)?.id ??
          (role === "quarter"
            ? plan.availableLabels.find((label) => label.label === "quarter")
                ?.id
            : "") ??
          "",
      ]),
    ),
  );
  const [error, setError] = useState("");
  const reserved = new Set(
    plan.managedLabels
      .filter((binding) => !ROLES.some((role) => role === binding.role))
      .map((binding) => binding.id),
  );
  const choices = plan.availableLabels.filter(
    (label) => !reserved.has(label.id),
  );

  async function save() {
    const labels: Binding[] = [];
    for (const role of ROLES) {
      const id = draft[role];
      if (!id && role === "quarter") continue;
      const label = choices.find((label) => label.id === id);
      if (!label) {
        setError(
          language === "zh"
            ? `请选择${titles[role]}的标签。`
            : `Choose a label for ${titles[role]}.`,
        );
        return;
      }
      const other = labels.find((binding) => binding.id === id);
      if (other) {
        setError(
          language === "zh"
            ? "每列需使用不同标签。"
            : "Use a different label for each column.",
        );
        return;
      }
      labels.push({ role, id: label.id, label: label.label });
    }
    if (await onSave(labels)) onClose();
  }

  return (
    <section className="plus-board-labels">
      <header>
        <h2>{text.boardLabels}</h2>
        <button className="plus-icon" aria-label={text.close} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p className="plus-muted">
        {language === "zh"
          ? `每列对应一个现有 ${taskAppName} 标签。更改对应关系不会搬动任务。`
          : `One column, one existing ${taskAppName} label. Changing the mapping does not move tasks.`}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {ROLES.map((role) => (
          <label key={role}>
            <span>{titles[role]}</span>
            <select
              aria-label={titles[role]}
              value={draft[role]}
              disabled={busy || !plan.configured}
              onChange={(event) => {
                setDraft({ ...draft, [role]: event.target.value });
                setError("");
              }}
            >
              <option value="">
                {role === "quarter"
                  ? language === "zh"
                    ? "暂不使用"
                    : "Not used"
                  : language === "zh"
                    ? "选择标签"
                    : "Choose label"}
              </option>
              {choices.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {error && (
          <p role="alert" className="plus-error">
            {error}
          </p>
        )}
        {!plan.configured && <p className="plus-warning">{text.setup}</p>}
        <footer>
          <button
            type="button"
            className="plus-text-button"
            onClick={onConnection}
          >
            <Settings size={13} />
            {text.manage}
          </button>
          <button
            className="plus-button plus-primary"
            disabled={
              busy || !plan.configured || !plan.etag || choices.length === 0
            }
          >
            {text.save}
          </button>
        </footer>
      </form>
    </section>
  );
}
