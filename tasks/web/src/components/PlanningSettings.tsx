import { RefreshCw } from "lucide-react";
import { usePlanningSettings } from "../usePlanningSettings";

export function PlanningSettings() {
  const { plan, loading, error, load } = usePlanningSettings();
  return (
    <div className="planning-settings list-view">
      <header className="view-header">
        <div>
          <h1>Planning settings</h1>
          <p className="view-subtitle">
            Stages, areas and start windows are built into Tasks.
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh planning settings"
          disabled={loading}
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
          <button className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {plan && (
        <section>
          <h2>Weekly planning</h2>
          <p>Timezone: {plan.timezone}.</p>
          <p>
            Unfinished commitments return to this week's candidates after Monday
            starts. Bets stay with their week.
          </p>
          {plan.nativePlanning && plan.enabled ? (
            <>
              <p>
                Move tasks between Quarter, Month, Week and Committed in Plan.
                Set work or personal context, start-ahead time and task options
                in a task's planning details. Your labels are ordinary tags.
              </p>
              <a className="primary-button" href="#/plan">
                Open Plan
              </a>
            </>
          ) : (
            <p role="status" className="muted">
              Native planning is not ready. Refresh after the Tasks source has
              been activated.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
