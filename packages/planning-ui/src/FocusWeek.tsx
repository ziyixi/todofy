import { useId, type CSSProperties } from "react";
import { displayedTitle, formattedMinutes } from "./domain";
import { dayTotals, groups, weekStats, type RangeStats } from "./focus-stats";
import { FullTitle, markCut } from "./FullTitle";
import { words } from "./i18n";
import { readableDate, shortDay } from "./PlanningCalendar";
import type { Area, DayPlan, FocusRange, Language } from "./model";

/** Whole minutes of logged seconds, as "3h 20m". */
export function loggedMinutes(seconds: number): string {
  return formattedMinutes(Math.floor(seconds / 60));
}

/** A record's colour in Week and Month: Work's and Personal's edge colours, the rest muted. */
export function areaFill(area: Area): string {
  return area === "unassigned"
    ? "var(--plus-muted)"
    : `var(--plus-area-${area})`;
}

/**
 * What a day's bar or calendar cell is called: "Tue, Oct 13: 3h 20m logged, work 2h, personal
 * 1h 20m, 3 of 5 steps done".
 */
export function dayName(day: DayPlan, language: Language): string {
  const zh = language === "zh";
  const text = words(language);
  const totals = dayTotals(day);
  const done = day.completedTaskIds.length;
  const all = done + day.taskIds.length;
  const parts = [
    text.logged(loggedMinutes(totals.total)),
    totals.work > 0 && `${zh ? "工作" : "work"} ${loggedMinutes(totals.work)}`,
    totals.personal > 0 &&
      `${zh ? "生活" : "personal"} ${loggedMinutes(totals.personal)}`,
    totals.unassigned > 0 &&
      `${zh ? "未分类" : "unassigned"} ${loggedMinutes(totals.unassigned)}`,
    all > 0 && (zh ? `完成 ${done}/${all}` : `${done} of ${all} steps done`),
  ].filter(Boolean);
  return `${readableDate(day.date, language)}${zh ? "：" : ": "}${parts.join(zh ? "，" : ", ")}`;
}

/** Week's and Month's numbers: logged, by area, steps done and time against the estimate. */
export function StatsRow({
  stats,
  language,
}: {
  stats: RangeStats;
  language: Language;
}) {
  const text = words(language);
  return (
    <dl className="plus-focus-stats">
      <div>
        <dt>{text.loggedLabel}</dt>
        <dd>{loggedMinutes(stats.total)}</dd>
      </div>
      <div>
        <dt data-area="work">{text.work}</dt>
        <dd>{loggedMinutes(stats.work)}</dd>
      </div>
      <div>
        <dt data-area="personal">{text.personal}</dt>
        <dd>{loggedMinutes(stats.personal)}</dd>
      </div>
      {stats.unassigned > 0 && (
        <div>
          <dt>{text.unassigned}</dt>
          <dd>{loggedMinutes(stats.unassigned)}</dd>
        </div>
      )}
      <div>
        <dt>{text.stepsDone}</dt>
        <dd>{stats.stepsDone}</dd>
      </div>
      {stats.ratio !== undefined && (
        <div title={text.tookEstimate(stats.ratio)}>
          <dt>{text.estimateRatio}</dt>
          <dd>{stats.ratio}%</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * Where the time went: the six largest groups of records by their task's immediate parent, each a
 * dot and a bar in the area of its latest record, then how many more there are.
 */
export function TimeGroups({
  days,
  tasks,
  language,
}: {
  days: readonly DayPlan[];
  tasks: FocusRange["tasks"];
  language: Language;
}) {
  const text = words(language);
  const heading = useId();
  const all = groups(days, tasks);
  if (!all.length) return null;
  const shown = all.slice(0, 6);
  const largest = shown[0]!.seconds;
  return (
    <section className="plus-focus-groups" aria-labelledby={heading}>
      <h3 id={heading}>{text.whereTimeWent}</h3>
      <ol>
        {shown.map((group) => (
          <li
            key={group.id}
            className="plus-focus-group"
            style={{ "--area-color": areaFill(group.area) } as CSSProperties}
            onPointerEnter={markCut}
          >
            <span className="plus-focus-group-dot" aria-hidden="true" />
            <FullTitle
              text={
                group.title ? displayedTitle(group.title) : text.missingTask
              }
            />
            <span className="plus-focus-group-bar" aria-hidden="true">
              <span style={{ width: `${(group.seconds / largest) * 100}%` }} />
            </span>
            <span className="plus-focus-group-time">
              {loggedMinutes(group.seconds)}
            </span>
          </li>
        ))}
      </ol>
      {all.length > shown.length && (
        <p className="plus-muted">
          {text.otherGroups(all.length - shown.length)}
        </p>
      )}
    </section>
  );
}

/**
 * Focus's Week: its numbers, a bar per day stacked by area (Work at the bottom) and scaled to the
 * busiest day, and where the time went. A day's bar opens it in Day.
 */
export function FocusWeek({
  range,
  today,
  language,
  onOpenDay,
}: {
  /** The week's seven days, Monday first. */
  range: FocusRange;
  today: string;
  language: Language;
  onOpenDay: (date: string) => void;
}) {
  const text = words(language);
  const stats = weekStats(range.days, range.tasks);
  const totals = range.days.map(dayTotals);
  const busiest = Math.max(0, ...totals.map((day) => day.total));
  return (
    <>
      <StatsRow stats={stats} language={language} />
      <div className="plus-focus-bars">
        {range.days.map((day, index) => {
          const logged = totals[index]!;
          return (
            <button
              key={day.date}
              type="button"
              className={day.date === today ? "is-today" : undefined}
              aria-label={dayName(day, language)}
              onClick={() => onOpenDay(day.date)}
            >
              <span className="plus-focus-bar-track" aria-hidden="true">
                {logged.total > 0 && (
                  <span className="plus-focus-bar-value">
                    {loggedMinutes(logged.total)}
                  </span>
                )}
                <span
                  className="plus-focus-bar"
                  style={
                    {
                      "--share": busiest ? logged.total / busiest : 0,
                    } as CSSProperties
                  }
                >
                  {(["work", "personal", "unassigned"] as const).map(
                    (area) =>
                      logged[area] > 0 && (
                        <span
                          key={area}
                          style={{
                            flexGrow: logged[area],
                            background: areaFill(area),
                          }}
                        />
                      ),
                  )}
                </span>
              </span>
              <span className="plus-focus-bar-day" aria-hidden="true">
                {shortDay(day.date, language)} {Number(day.date.slice(8))}
              </span>
            </button>
          );
        })}
      </div>
      {stats.total === 0 && <p className="plus-muted">{text.noTimeWeek}</p>}
      <TimeGroups days={range.days} tasks={range.tasks} language={language} />
    </>
  );
}
