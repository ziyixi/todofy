import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, RefreshCw } from "lucide-react";
import type {
  GtdDay,
  GtdScope,
  WeeklyReview,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { WeeklyReview_State } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { api, describeError } from "./api";
import { TrendChart } from "./components/TrendChart";
import "./gtd.css";

/** The trend's days: today and the 29 before it. */
export const GTD_DAYS = 30;

const REVIEW_STATE: Record<number, string> = {
  [WeeklyReview_State.CREATED]: "created",
  [WeeklyReview_State.UNKNOWN]: "result unknown",
  [WeeklyReview_State.FAILED]: "failed",
};

function values(
  days: readonly GtdDay[],
  scope: "allProjects" | "inbox",
  pick: (value: GtdScope) => number | undefined,
): (number | null)[] {
  return days.map((day) => {
    const value = day[scope];
    return value ? (pick(value) ?? null) : null;
  });
}
const count = (value: number | undefined) =>
  value === undefined ? "Unavailable" : value.toLocaleString("en-US");
const dayOf = (name: string) => name.slice(name.indexOf("/") + 1);
const dateOf = (time: { seconds: bigint } | undefined) =>
  time ? new Date(Number(time.seconds) * 1000).toISOString().slice(0, 10) : "";

/**
 * GTD statistics: counts of the open tasks Tasks writes once a day after 06:00, and the Sunday review, never a task
 * title. The review task is where the owner acts; this page shows the trend.
 */
export default function GtdPage({
  onOpenTask,
}: {
  onOpenTask: (id: string) => void;
}) {
  const [days, setDays] = useState<GtdDay[]>();
  const [review, setReview] = useState<WeeklyReview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const read = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [listed, reviews] = await Promise.all([
        api.listGtdDays({ pageSize: GTD_DAYS }),
        api.listWeeklyReviews({ pageSize: 1 }),
      ]);
      if (current !== generation.current) return;
      // The chart reads oldest first.
      setDays([...listed.gtdDays].reverse());
      setReview(reviews.weeklyReviews[0]);
    } catch (reason) {
      if (current === generation.current) setError(describeError(reason));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void read();
    return () => {
      generation.current += 1;
    };
  }, [read]);

  const latest = days && [...days].reverse().find((day) => day.recorded);
  const all = latest?.allProjects;
  const inbox = latest?.inbox;
  const chart = days && {
    days: days.map((day) => dayOf(day.name)),
    recorded: days.map((day) => day.recorded),
  };
  return (
    <section className="list-view gtd-page">
      <header className="view-header">
        <div>
          <h1>GTD</h1>
          <p className="view-subtitle">
            Counts of your open tasks, taken once a day after 6:00, and the
            weekly review Tasks creates on Sunday from 10:00.
          </p>
        </div>
        <button
          className="icon-button view-refresh"
          aria-label="Refresh GTD"
          disabled={loading}
          onClick={() => void read()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      {error && (
        <p className="error-message" role="alert">
          {error}
          <button className="text-button" onClick={() => void read()}>
            Refresh
          </button>
        </p>
      )}
      {!days && loading && <p className="loading-state">Loading GTD…</p>}
      {days && (
        <>
          <section className="gtd-section" aria-labelledby="gtd-review">
            <h2 id="gtd-review">Weekly review</h2>
            {review ? (
              <dl className="gtd-facts">
                <div>
                  <dt>Latest</dt>
                  <dd>
                    Week of {dayOf(review.name)} ·{" "}
                    {REVIEW_STATE[review.state] ?? "unknown"}
                  </dd>
                </div>
                <div>
                  <dt>Completed</dt>
                  <dd>
                    {review.completeTime
                      ? dateOf(review.completeTime)
                      : "Not yet"}
                    {review.reviewTaskId && (
                      <button
                        className="text-button gtd-open-review"
                        onClick={() => onOpenTask(review.reviewTaskId)}
                      >
                        Open task
                      </button>
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="gtd-note">No review task yet.</p>
            )}
          </section>
          {!all ? (
            <div className="empty-state">
              <ListChecks />
              <h2>No counts yet</h2>
              <p>Tasks counts your open tasks once a day after 6:00.</p>
            </div>
          ) : (
            <>
              <section className="gtd-section" aria-labelledby="gtd-latest">
                <h2 id="gtd-latest">
                  {dayOf(latest?.name ?? "")}
                  {!all.complete && (
                    <span className="gtd-note"> · incomplete count</span>
                  )}
                </h2>
                <dl className="gtd-facts">
                  <div>
                    <dt>Inbox open</dt>
                    <dd>{inbox ? count(inbox.openCount) : "—"}</dd>
                  </div>
                  <div>
                    <dt>Oldest in Inbox</dt>
                    <dd>
                      {inbox ? `${count(inbox.oldestAgeDays)} days` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>All open</dt>
                    <dd>{count(all.openCount)}</dd>
                  </div>
                  <div>
                    <dt>Overdue</dt>
                    <dd>{count(all.overdueCount)}</dd>
                  </div>
                  <div>
                    <dt>Undated</dt>
                    <dd>{count(all.undatedCount)}</dd>
                  </div>
                  <div>
                    <dt>Created / completed, 7 days</dt>
                    <dd>
                      {count(all.createdLastWeekCount)} /{" "}
                      {count(all.completedLastWeekCount)}
                    </dd>
                  </div>
                  <div>
                    <dt>Mail awaiting a decision, 1–14 days old</dt>
                    <dd>{count(all.openMailCount)}</dd>
                  </div>
                </dl>
              </section>
              {chart && (
                <section className="gtd-section" aria-labelledby="gtd-trend">
                  <h2 id="gtd-trend">The last {GTD_DAYS} days</h2>
                  <div className="gtd-trends">
                    <TrendChart
                      {...chart}
                      title="Open and overdue"
                      variant="line"
                      series={[
                        {
                          label: "Inbox open",
                          color: 1,
                          values: values(days, "inbox", (v) => v.openCount),
                        },
                        {
                          label: "All open",
                          color: 2,
                          values: values(
                            days,
                            "allProjects",
                            (v) => v.openCount,
                          ),
                        },
                        {
                          label: "Overdue",
                          color: "danger",
                          values: values(
                            days,
                            "allProjects",
                            (v) => v.overdueCount,
                          ),
                        },
                      ]}
                    />
                    <TrendChart
                      {...chart}
                      title="Created and completed, 7 days"
                      variant="line"
                      series={[
                        {
                          label: "Created",
                          color: 1,
                          values: values(
                            days,
                            "allProjects",
                            (v) => v.createdLastWeekCount,
                          ),
                        },
                        {
                          label: "Completed",
                          color: 2,
                          values: values(
                            days,
                            "allProjects",
                            (v) => v.completedLastWeekCount,
                          ),
                        },
                      ]}
                    />
                    <TrendChart
                      {...chart}
                      title="Inbox task age"
                      variant="bar"
                      series={[
                        {
                          label: "0–7 days",
                          color: 1,
                          values: values(days, "inbox", (v) => v.freshCount),
                        },
                        {
                          label: "8–14 days",
                          color: 2,
                          values: values(days, "inbox", (v) => v.recentCount),
                        },
                        {
                          label: "15–30 days",
                          color: 3,
                          values: values(days, "inbox", (v) => v.staleCount),
                        },
                        {
                          label: "Over 30 days",
                          color: 4,
                          values: values(days, "inbox", (v) => v.oldCount),
                        },
                      ]}
                    />
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
