import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Calendar,
  CalendarDays,
  ChevronDown,
  Hash,
  Inbox,
  LayoutList,
  ListFilter,
  Moon,
  MoreHorizontal,
  PlusCircle,
  RotateCcw,
  Search,
  Settings2,
  Sun,
  Target,
  X,
} from "lucide-react";
import { ReviewBoard } from "./ReviewBoard";
import { PlanningWeek } from "./PlanningWeek";
import { PlanningDetails } from "./PlanningDetails";
import { PrototypeFocus } from "./PrototypeFocus";
import { planningFixture } from "./planning-fixture";
import {
  CURRENT_WEEK,
  LANES,
  TODAY,
  moveOutcome,
  moveStep,
  type Outcome,
} from "./planning-model";
import "../src/styles.css";
import "./prototype.css";
import "./planning.css";

function Prototype() {
  const [data, setData] = useState(planningFixture);
  const [view, setView] = useState<"plan" | "focus">("plan");
  const [mode, setMode] = useState<"review" | "week">("review");
  const [area, setArea] = useState<"all" | "work" | "personal">("all");
  const [week, setWeek] = useState(CURRENT_WEEK);
  const [dark, setDark] = useState(false);
  const [selected, setSelected] = useState("");
  const [runningStep, setRunningStep] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const selectedOutcome = data.outcomes.find(
    (outcome) => outcome.id === selected,
  );
  const commitments = data.outcomes.filter(
    (outcome) => outcome.lane === "committed",
  );
  const workCount = commitments.filter(
    (outcome) => outcome.area === "work",
  ).length;
  const personalCount = commitments.filter(
    (outcome) => outcome.area === "personal",
  ).length;

  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);

  function saveOutcome(outcome: Outcome) {
    setData((current) => ({
      ...current,
      outcomes: current.outcomes.map((item) =>
        item.id === outcome.id ? outcome : item,
      ),
    }));
  }

  function showWeek() {
    setView("plan");
    setMode("week");
  }

  function resetDemo() {
    setData(planningFixture());
    setWeek(CURRENT_WEEK);
    setArea("all");
    setRunningStep("");
  }

  return (
    <div className="plus-prototype" data-theme={dark ? "dark" : "light"}>
      <aside className="prototype-sidebar">
        <div className="prototype-owner">
          <span className="prototype-avatar">P</span>Personal{" "}
          <ChevronDown size={13} />
        </div>
        <nav>
          <button className="prototype-native-item prototype-add-task">
            <PlusCircle size={19} />
            Add task
          </button>
          <div className="prototype-nav-gap" />
          <button className="prototype-native-item">
            <Search size={19} />
            Search
          </button>
          <button className="prototype-native-item">
            <Inbox size={19} />
            Inbox
          </button>
          <button onClick={() => setView("focus")}>
            <Calendar size={19} />
            Today<small>{(data.queues[TODAY] ?? []).length}</small>
          </button>
          <button onClick={showWeek}>
            <CalendarDays size={19} />
            Upcoming
          </button>
          <button className="prototype-native-item">
            <ListFilter size={19} />
            Filters & Labels
          </button>
          <button className="prototype-native-item">
            <MoreHorizontal size={19} />
            More
          </button>
          <div className="prototype-nav-gap" />
          <button
            className={view === "plan" ? "active" : ""}
            onClick={() => setView("plan")}
          >
            <span className="plus-nav-icon">
              <LayoutList size={18} />
            </span>
            Plan
          </button>
          <button
            className={view === "focus" ? "active" : ""}
            onClick={() => setView("focus")}
          >
            <span className="plus-nav-icon">
              <Target size={18} />
            </span>
            Focus
          </button>
          <div className="prototype-nav-heading">Favorites</div>
          <div className="prototype-nav-heading">My projects</div>
          <button className="prototype-native-item">
            <Hash size={19} />
            Work
          </button>
          <button className="prototype-native-item">
            <Hash size={19} />
            Personal
          </button>
        </nav>
        <div className="prototype-controls">
          <small>LOCAL · SYNTHETIC TASKS</small>
          <div>
            <button onClick={() => setDark(!dark)} aria-label="Switch theme">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={resetDemo}>
              <RotateCcw size={14} />
              Reset demo
            </button>
          </div>
        </div>
      </aside>
      <main>
        <div
          className={`planning-root ${view === "focus" ? "planning-focus-root" : ""}`}
        >
          <header className="planning-page-header">
            <div>
              <h1>{view === "plan" ? "Plan" : "Focus"}</h1>
              <p>
                {view === "plan"
                  ? `This week · ${workCount} work / ${personalCount} personal commitments`
                  : "Tuesday, October 13 · Your planned steps"}
              </p>
            </div>
            <button
              className="plus-icon"
              aria-label="Board labels"
              onClick={() => setSelected("labels")}
            >
              <Settings2 size={18} />
            </button>
          </header>
          {view === "plan" ? (
            <>
              <div className="planning-toolbar">
                <nav className="planning-view-tabs" aria-label="Planning view">
                  <button
                    aria-selected={mode === "review"}
                    onClick={() => setMode("review")}
                  >
                    Review
                  </button>
                  <button
                    aria-selected={mode === "week"}
                    onClick={() => setMode("week")}
                  >
                    Week
                  </button>
                </nav>
                {mode === "review" && (
                  <nav className="planning-area-tabs" aria-label="Task area">
                    {(["all", "work", "personal"] as const).map((value) => (
                      <button
                        key={value}
                        aria-selected={area === value}
                        onClick={() => setArea(value)}
                      >
                        {value === "all"
                          ? "All"
                          : value === "work"
                            ? "Work"
                            : "Personal"}
                      </button>
                    ))}
                  </nav>
                )}
                <span>
                  {mode === "review"
                    ? "Move outcomes between planning labels"
                    : "Arrange steps · Todoist dates stay as they are"}
                </span>
              </div>
              {mode === "review" ? (
                <ReviewBoard
                  outcomes={data.outcomes}
                  queues={data.queues}
                  area={area}
                  onMove={(id, lane) =>
                    setData((current) => moveOutcome(current, id, lane))
                  }
                  onEdit={setSelected}
                />
              ) : (
                <PlanningWeek
                  outcomes={data.outcomes}
                  queues={data.queues}
                  week={week}
                  onWeekChange={setWeek}
                  onMove={(id, date, sourceDate, beforeId) =>
                    setData((current) =>
                      moveStep(current, id, date, sourceDate, beforeId),
                    )
                  }
                  onRemove={(id, date) =>
                    setData((current) => ({
                      ...current,
                      queues: {
                        ...current.queues,
                        [date]: (current.queues[date] ?? []).filter(
                          (stepId) => stepId !== id,
                        ),
                      },
                    }))
                  }
                  onEdit={setSelected}
                />
              )}
            </>
          ) : (
            <PrototypeFocus
              outcomes={data.outcomes}
              ids={data.queues[TODAY] ?? []}
              running={runningStep}
              onRunning={setRunningStep}
              onSave={saveOutcome}
              onEdit={setSelected}
              onPlan={showWeek}
            />
          )}
        </div>
      </main>
      <dialog
        className="planning-dialog"
        ref={dialog}
        onCancel={() => setSelected("")}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelected("");
        }}
      >
        {selectedOutcome ? (
          <PlanningDetails
            key={selectedOutcome.id}
            outcome={selectedOutcome}
            onSave={saveOutcome}
            onClose={() => setSelected("")}
          />
        ) : selected === "labels" ? (
          <section className="planning-labels">
            <header>
              <h2>Board labels</h2>
              <button
                className="plus-icon"
                aria-label="Close"
                onClick={() => setSelected("")}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              One column, one Todoist label. Quarter is a manual candidate pool.
            </p>
            {LANES.map((lane) => (
              <div key={lane.id}>
                <span>{lane.title}</span>
                <code>{lane.label}</code>
              </div>
            ))}
            <p className="planning-demo-note">
              This prototype simulates labels. Existing tasks and labels are not
              changed.
            </p>
          </section>
        ) : null}
      </dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Prototype />);
