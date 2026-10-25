import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { GtdReport } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { addDays, mondayOf, monthStart } from "@ziyixi/planning-ui/domain";
import { api, describeError } from "./api";
import { todayDate } from "./dates";
import { GtdOverview, GtdCompletion } from "./gtd/GtdCompletion";
import { GtdTime } from "./gtd/GtdTime";
import {
  dateRangeLabel,
  reportRange,
  type GtdPeriod,
  type GtdTab,
} from "./gtd/model";
import "./gtd.css";

const TABS: readonly GtdTab[] = ["overview", "completion", "time"];
const TITLES: Record<GtdTab, string> = {
  overview: "Overview",
  completion: "Completion",
  time: "Time",
};

/** Execution review. Changing tabs reuses the same bounded period read. */
export default function GtdPage({
  selectedTab,
  timeZone,
  refreshRevision,
  onOpenTask,
  onOpenDay,
}: {
  selectedTab: string;
  timeZone: string;
  refreshRevision: number;
  onOpenTask: (id: string) => void;
  onOpenDay: (day: string) => void;
}) {
  const tab: GtdTab = TABS.includes(selectedTab as GtdTab)
    ? (selectedTab as GtdTab)
    : "overview";
  const [period, setPeriod] = useState<GtdPeriod>("week");
  const [anchor, setAnchor] = useState("");
  const [area, setArea] = useState("");
  const [report, setReport] = useState<GtdReport>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const today = report?.today || todayDate(new Date(), timeZone || undefined);
  const date = anchor || today;
  const [startDay, endDay] = reportRange(period, date);
  const key = `${startDay}/${endDay}/${area}`;
  const shownKey =
    report && `${report.startDay}/${report.endDay}/${report.area}`;
  const changing = loading && shownKey !== key;
  const read = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.getGtdReport({
        name: "gtdReport",
        startDay,
        endDay,
        area,
      });
      if (current === generation.current) setReport(result);
    } catch (reason) {
      if (current === generation.current) setError(describeError(reason));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [startDay, endDay, area]);
  useEffect(() => {
    void read();
    return () => {
      generation.current++;
    };
  }, [read, refreshRevision]);

  function move(direction: number) {
    setAnchor(
      period === "week"
        ? addDays(date, direction * 7)
        : monthStart(date, direction),
    );
  }
  const thisPeriod =
    period === "week"
      ? mondayOf(today) === startDay
      : today.slice(0, 7) === startDay.slice(0, 7);
  return (
    <section className="gtd-page" aria-label="GTD progress and time">
      <header className="view-header">
        <div>
          <h1>GTD</h1>
          <p className="view-subtitle">Progress &amp; time</p>
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
      <div className="gtd-tabs" role="tablist" aria-label="GTD views">
        {TABS.map((value) => (
          <a
            key={value}
            role="tab"
            id={`gtd-tab-${value}`}
            aria-controls="gtd-panel"
            aria-selected={tab === value}
            href={`#/gtd/${value}`}
          >
            {TITLES[value]}
          </a>
        ))}
      </div>
      <div className="gtd-toolbar">
        <nav className="gtd-date-nav" aria-label="GTD date range">
          <button
            className="icon-button"
            aria-label={`Previous ${period}`}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <span>{dateRangeLabel(startDay, endDay, period)}</span>
          <button
            className="icon-button"
            aria-label={`Next ${period}`}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </button>
          {!thisPeriod && (
            <button className="text-button" onClick={() => setAnchor(today)}>
              Today
            </button>
          )}
        </nav>
        <div className="gtd-controls">
          <div className="gtd-period" role="group" aria-label="GTD period">
            {(["week", "month"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
              >
                {value === "week" ? "Week" : "Month"}
              </button>
            ))}
          </div>
          <select
            aria-label="GTD area"
            value={area}
            onChange={(event) => setArea(event.target.value)}
          >
            <option value="">All areas</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </select>
        </div>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
          <button className="text-button" onClick={() => void read()}>
            Retry
          </button>
        </p>
      )}
      {!report && loading && (
        <p className="loading-state" role="status">
          Loading progress and time…
        </p>
      )}
      {report && (shownKey === key || loading) && (
        <div
          id="gtd-panel"
          className={`gtd-panel${changing ? " is-loading" : ""}`}
          role="tabpanel"
          aria-labelledby={`gtd-tab-${tab}`}
          aria-busy={loading}
          inert={shownKey !== key || undefined}
        >
          {tab === "overview" && (
            <GtdOverview
              report={report}
              period={period}
              onOpenTask={onOpenTask}
            />
          )}
          {tab === "completion" && (
            <GtdCompletion
              report={report}
              period={period}
              onOpenTask={onOpenTask}
            />
          )}
          {tab === "time" && (
            <GtdTime
              report={report}
              period={period}
              onOpenDay={onOpenDay}
              onOpenTask={onOpenTask}
            />
          )}
        </div>
      )}
    </section>
  );
}
