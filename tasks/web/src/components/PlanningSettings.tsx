import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { describeError } from "../api";
import { planningApi, type usePlanningSettings } from "../usePlanningSettings";

const columns = [
  ["quarter", "Quarter"],
  ["candiate", "Month"],
  ["focus", "Week"],
  ["committed", "Committed"],
] as const;
export function PlanningSettings({
  state,
}: {
  state: ReturnType<typeof usePlanningSettings>;
}) {
  const { plan, setPlan, loading, error, load } = state;
  const [ids, setIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!loading) void load();
  }, []);
  useEffect(() => {
    if (plan)
      setIds(
        Object.fromEntries(
          columns.map(([role]) => [
            role,
            plan.labels.find((binding) => binding.role === role)?.id || "",
          ]),
        ),
      );
  }, [plan]);
  async function confirm() {
    if (!plan) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await planningApi.confirmPlanMapping({
        etag: plan.etag,
        requestId: crypto.randomUUID(),
      });
      setPlan(result.plan);
      setMessage("Planning is enabled.");
    } catch (reason) {
      setMessage(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!plan) return;
    setBusy(true);
    setMessage("");
    try {
      const labels = columns.flatMap(([role]) => {
        const label = plan.availableLabels.find(
          (item) => item.id === ids[role],
        );
        return label ? [{ role, id: label.id, label: label.label }] : [];
      });
      const result = await planningApi.updatePlanLabels({
        labels,
        etag: plan.etag,
        requestId: crypto.randomUUID(),
      });
      setPlan(result.plan);
      setMessage("Planning columns saved.");
    } catch (reason) {
      setMessage(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  const changed =
    plan &&
    columns.some(
      ([role]) =>
        (ids[role] || "") !==
        (plan.labels.find((binding) => binding.role === role)?.id || ""),
    );
  return (
    <div className="planning-settings list-view">
      <header className="view-header">
        <div>
          <h1>Planning settings</h1>
          <p className="view-subtitle">
            Your existing labels connect the task list and the planning board.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh planning settings"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      {loading && (
        <p role="status" className="muted">
          Reading planning settings…
        </p>
      )}
      {error && (
        <div className="error-message" role="alert">
          <p>{error}</p>
          <p>
            Planning becomes available after Todofy and FlowDay have switched to
            Tasks. No extension token or API key is needed here.
          </p>
          <button className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {plan && (
        <>
          <section>
            <h2>Weekly planning</h2>
            <p>
              Timezone: {plan.timezone}. After Monday starts, the next regular
              check returns last week's unfinished commitments to this week's
              candidates. Bets stay saved with their week.
            </p>
            <dl className="mapping-list">
              {plan.labels
                .filter((binding) => binding.role !== "bets")
                .map((binding) => (
                  <div key={binding.role}>
                    <dt>
                      {columns.find(([role]) => role === binding.role)?.[1] ||
                        binding.role}
                    </dt>
                    <dd>{binding.label}</dd>
                  </div>
                ))}
            </dl>
            {plan.missingLabels.length > 0 && (
              <p className="error-message">
                Missing label mappings: {plan.missingLabels.join(", ")}.{" "}
                <a href="#/catalog">Check labels</a>, then refresh this page. An
                imported mapping keeps its exact IDs.
              </p>
            )}
            <button
              className="primary-button"
              disabled={
                busy || loading || plan.enabled || plan.missingLabels.length > 0
              }
              onClick={() => void confirm()}
            >
              {plan.enabled
                ? "Planning enabled"
                : "Confirm mapping and enable planning"}
            </button>
          </section>
          <section>
            <h2>Board columns</h2>
            <p>
              Choose an existing label for each column. Quarter is optional.
              Changing a mapping does not move your tasks.
            </p>
            <div className="planning-columns">
              {columns.map(([role, title]) => (
                <label key={role}>
                  {title}
                  <select
                    aria-label={`${title} label`}
                    disabled={busy || loading || !plan.enabled}
                    value={ids[role] || ""}
                    onChange={(event) =>
                      setIds((current) => ({
                        ...current,
                        [role]: event.target.value,
                      }))
                    }
                  >
                    <option value="">
                      {role === "quarter" ? "Not mapped" : "Choose a label"}
                    </option>
                    {plan.availableLabels.map((label) => (
                      <option value={label.id} key={label.id}>
                        {label.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              className="primary-button"
              disabled={
                busy ||
                loading ||
                !plan.enabled ||
                !changed ||
                columns.some(([role]) => role !== "quarter" && !ids[role])
              }
              onClick={() => void save()}
            >
              Save columns
            </button>
          </section>
        </>
      )}
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
    </div>
  );
}
