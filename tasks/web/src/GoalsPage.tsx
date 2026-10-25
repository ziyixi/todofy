import { useCallback, useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Target,
} from "lucide-react";
import type {
  GoalProgress as Progress,
  KeyResult,
  Objective,
} from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import type { Plan } from "@ziyixi/proto/tasks/ui/v1/plan_pb";
import type { MessageInitShape } from "@ziyixi/proto/protobuf";
import { KeyResultSchema } from "@ziyixi/proto/tasks/ui/v1/goals_pb";
import { api, describeError, type Task } from "./api";
import {
  clearGoalCatalogCache,
  loadGoalCatalog,
  type GoalCatalog,
} from "./goals-client";
import { GoalEditor, GoalFocusEditor } from "./components/GoalEditor";
import { GoalProgress } from "./components/GoalProgress";
import { GoalDefinition } from "./components/GoalDefinition";
import { GoalRelatedTasks } from "./components/GoalRelatedTasks";
import "./goals.css";

function focusPeriod(goal: KeyResult) {
  const format = (month: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${month}-01T12:00:00Z`));
  return `${format(goal.focusStartMonth)}${goal.focusEndMonth !== goal.focusStartMonth ? ` – ${format(goal.focusEndMonth)}` : ""} focus`;
}

export default function GoalsPage({
  selectedId,
  refreshRevision,
  onOpenTask,
  onCreateTask,
  onCompleteTask,
}: {
  selectedId: string;
  refreshRevision: number;
  onOpenTask: (id: string) => void;
  onCreateTask: (keyResultId: string) => void;
  onCompleteTask: (task: Task) => Promise<string | undefined>;
}) {
  const [year, setYear] = useState(0);
  const [catalog, setCatalog] = useState<GoalCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [objectiveId, setObjectiveId] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [plan, setPlan] = useState<Plan>();
  const [planError, setPlanError] = useState("");
  const [goal, setGoal] = useState<KeyResult>();
  const [goalError, setGoalError] = useState("");
  const [progress, setProgress] = useState<Progress[]>([]);
  const [progressPage, setProgressPage] = useState("");
  const [progressLoading, setProgressLoading] = useState(false);
  const [progressError, setProgressError] = useState("");
  const [editor, setEditor] = useState<{
    kind: "objective" | "keyResult";
    objective?: Objective;
    keyResult?: KeyResult;
  }>();
  const [focusEditor, setFocusEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [relatedRefreshRevision, setRelatedRefreshRevision] = useState(0);
  const catalogGeneration = useRef(0);
  const goalGeneration = useRef(0);
  const progressGeneration = useRef(0);
  const resultRequest = useRef<
    { proof: string; requestId: string } | undefined
  >(undefined);
  const readCatalog = useCallback(async () => {
    const request = ++catalogGeneration.current;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const loaded = await loadGoalCatalog(year);
      if (request === catalogGeneration.current) setCatalog(loaded);
    } catch (reason) {
      if (request === catalogGeneration.current)
        setCatalogError(describeError(reason));
    } finally {
      if (request === catalogGeneration.current) setCatalogLoading(false);
    }
  }, [year]);
  useEffect(() => {
    void readCatalog();
    return () => {
      catalogGeneration.current++;
    };
  }, [readCatalog]);
  const readPlan = useCallback(async () => {
    setPlanError("");
    try {
      setPlan(await api.getPlan({ name: "plan" }));
    } catch (reason) {
      setPlanError(describeError(reason));
    }
  }, []);
  useEffect(() => {
    void readPlan();
  }, [readPlan]);

  const visibleCatalog =
    catalog && (!year || catalog.year === year) ? catalog : undefined;
  const linkedSummary = visibleCatalog?.keyResults.find(
    (item) => item.id === selectedId,
  );
  const objectives =
    visibleCatalog?.objectives.filter(
      (item) =>
        showArchived ||
        !item.archived ||
        item.id === linkedSummary?.objectiveId,
    ) ?? [];
  const objective =
    objectives.find((item) => item.id === linkedSummary?.objectiveId) ??
    objectives.find((item) => item.id === objectiveId) ??
    objectives[0];
  const results =
    visibleCatalog?.keyResults.filter(
      (item) =>
        item.objectiveId === objective?.id &&
        (showArchived ||
          (!item.archived && !item.objectiveArchived) ||
          item.id === selectedId),
    ) ?? [];
  const chosenId = selectedId || results[0]?.id || "";
  const selectedGoal = goal?.id === chosenId ? goal : undefined;
  const readGoal = useCallback(async () => {
    if (!chosenId) return;
    const request = ++goalGeneration.current;
    setGoalError("");
    try {
      const loaded = await api.getKeyResult({ name: `keyResults/${chosenId}` });
      if (request !== goalGeneration.current) return;
      setGoal(loaded);
    } catch (reason) {
      if (request === goalGeneration.current)
        setGoalError(describeError(reason));
    }
  }, [chosenId]);
  useEffect(() => {
    // A task link may open a result from another year.
    if (
      selectedId &&
      goal?.id === selectedId &&
      catalog &&
      goal.year !== catalog.year
    )
      setYear(goal.year);
  }, [selectedId, goal, catalog]);
  const readProgress = useCallback(
    async (pageToken = "") => {
      if (!chosenId) return;
      const request = ++progressGeneration.current;
      setProgressLoading(true);
      setProgressError("");
      try {
        const listed = await api.listGoalProgress({
          keyResultId: chosenId,
          pageSize: 20,
          pageToken,
        });
        if (request !== progressGeneration.current) return;
        setProgress((current) =>
          pageToken
            ? [
                ...current,
                ...listed.goalProgress.filter(
                  (item) => !current.some((value) => value.id === item.id),
                ),
              ]
            : listed.goalProgress,
        );
        setProgressPage(listed.nextPageToken);
      } catch (reason) {
        if (request === progressGeneration.current)
          setProgressError(describeError(reason));
      } finally {
        if (request === progressGeneration.current) setProgressLoading(false);
      }
    },
    [chosenId],
  );
  useEffect(() => {
    setGoal(undefined);
    setProgress([]);
    setProgressPage("");
    void readGoal();
    void readProgress();
    return () => {
      goalGeneration.current++;
      progressGeneration.current++;
    };
  }, [chosenId, readGoal, readProgress]);
  async function goalSaved(saved: Objective | KeyResult) {
    clearGoalCatalogCache();
    if ("objectiveId" in saved) {
      goalGeneration.current++;
      setGoal(saved);
      window.location.hash = `/goals/${encodeURIComponent(saved.id)}`;
    } else {
      setObjectiveId(saved.id);
      if (saved.id !== objective?.id) window.location.hash = "/goals";
    }
    await readCatalog();
  }
  async function updateResult(
    values: MessageInitShape<typeof KeyResultSchema>,
    paths: string[],
  ) {
    if (!selectedGoal) return;
    setSaving(true);
    setGoalError("");
    try {
      const proof = JSON.stringify(
        [selectedGoal.name, selectedGoal.etag, paths, values],
        (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
      );
      if (resultRequest.current?.proof !== proof)
        resultRequest.current = { proof, requestId: crypto.randomUUID() };
      const saved = await api.updateKeyResult({
        keyResult: { name: selectedGoal.name, ...values },
        updateMask: { paths },
        etag: selectedGoal.etag,
        requestId: resultRequest.current.requestId,
      });
      await goalSaved(saved);
    } catch (reason) {
      setGoalError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }
  function chooseObjective(next: Objective) {
    setObjectiveId(next.id);
    const first = visibleCatalog?.keyResults.find(
      (item) =>
        item.objectiveId === next.id && (showArchived || !item.archived),
    );
    window.location.hash = first
      ? `/goals/${encodeURIComponent(first.id)}`
      : "/goals";
  }
  function changeYear(next: number) {
    setYear(next);
    setObjectiveId("");
    window.location.hash = "/goals";
  }
  async function refresh() {
    clearGoalCatalogCache();
    setRelatedRefreshRevision((revision) => revision + 1);
    await Promise.all([readCatalog(), readGoal(), readProgress(), readPlan()]);
  }
  const displayedYear = year || catalog?.year;
  return (
    <section className="goals-page">
      <header className="view-header">
        <div>
          <h1>Goals</h1>
          <div className="goal-year">
            <button
              className="icon-button"
              aria-label="Previous year"
              disabled={!displayedYear || displayedYear <= 2000}
              onClick={() => changeYear((displayedYear ?? 2001) - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <span>{displayedYear ?? "…"} · Annual goals</span>
            <button
              className="icon-button"
              aria-label="Next year"
              disabled={!displayedYear || displayedYear >= 2199}
              onClick={() => changeYear((displayedYear ?? 2198) + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
        <div className="view-tools">
          <button
            className="icon-button"
            aria-label="Refresh Goals"
            disabled={catalogLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} />
          </button>
          <Menu.Root>
            <Menu.Trigger className="icon-button" aria-label="Manage goals">
              <MoreHorizontal size={19} />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={4}>
                <Menu.Popup className="task-menu">
                  <Menu.Item
                    className="task-menu-item"
                    onClick={() => setEditor({ kind: "objective" })}
                  >
                    <Plus size={15} />
                    Add objective
                  </Menu.Item>
                  {objective && (
                    <>
                      <Menu.Item
                        className="task-menu-item"
                        onClick={() =>
                          setEditor({ kind: "keyResult", objective })
                        }
                      >
                        <Plus size={15} />
                        Add key result
                      </Menu.Item>
                      <Menu.Item
                        className="task-menu-item"
                        onClick={() =>
                          setEditor({ kind: "objective", objective })
                        }
                      >
                        <Pencil size={15} />
                        Edit objective
                      </Menu.Item>
                    </>
                  )}
                  <Menu.Item
                    className="task-menu-item"
                    onClick={() => setShowArchived((current) => !current)}
                  >
                    {showArchived
                      ? "Hide archived goals"
                      : "Show archived goals"}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </header>
      {catalogError && (
        <p className="error-message" role="alert">
          {catalogError}
          <button className="text-button" onClick={() => void readCatalog()}>
            Retry
          </button>
        </p>
      )}
      {!visibleCatalog && catalogLoading && (
        <p className="loading-state" role="status">
          Loading Goals…
        </p>
      )}
      {visibleCatalog && (
        <>
          {objectives.length > 0 && (
            <div
              className="goal-objective-tabs"
              role="tablist"
              aria-label="Annual objectives"
            >
              {objectives.map((item) => (
                <button
                  role="tab"
                  aria-selected={objective?.id === item.id}
                  key={item.id}
                  className={objective?.id === item.id ? "is-active" : ""}
                  onClick={() => chooseObjective(item)}
                >
                  {item.title}
                  {item.archived && (
                    <span className="goal-archived">Archived</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {objective && (
            <div className="goal-result-nav">
              <label htmlFor="goal-result">Key result</label>
              <select
                id="goal-result"
                value={chosenId}
                onChange={(event) => {
                  window.location.hash = `/goals/${encodeURIComponent(event.target.value)}`;
                }}
              >
                {results.map((result) => (
                  <option key={result.id} value={result.id}>
                    {result.title}
                    {result.archived || result.objectiveArchived
                      ? " · Archived"
                      : ""}
                  </option>
                ))}
              </select>
              {selectedGoal && (
                <button
                  className="icon-button"
                  aria-label="Edit key result"
                  onClick={() =>
                    setEditor({
                      kind: "keyResult",
                      objective,
                      keyResult: selectedGoal,
                    })
                  }
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>
          )}
          {(!objectives.length || (!chosenId && !results.length)) && (
            <div className="empty-state">
              <Target size={30} />
              <h2>
                {!objectives.length
                  ? "No goals for this year"
                  : "No key results yet"}
              </h2>
              <p>
                {!objectives.length
                  ? "Add an annual objective, then the results you want to work toward."
                  : "Add a result, routine or exploration under this objective."}
              </p>
              <button
                className="primary-button"
                onClick={() =>
                  setEditor({
                    kind: objective ? "keyResult" : "objective",
                    objective,
                  })
                }
              >
                <Plus size={15} />
                {objective ? "Add key result" : "Add objective"}
              </button>
            </div>
          )}
          {chosenId && !selectedGoal && !goalError && (
            <p className="loading-state" role="status">
              Loading key result…
            </p>
          )}
        </>
      )}
      {goalError && (
        <p className="error-message" role="alert">
          {goalError}
          <button className="text-button" onClick={() => void readGoal()}>
            Retry
          </button>
        </p>
      )}
      {selectedGoal && visibleCatalog && (
        <>
          <div
            className={`goal-current-focus ${selectedGoal.focusText ? "has-focus" : ""}`}
          >
            <span className="goal-focus-period">
              {selectedGoal.focusStartMonth
                ? focusPeriod(selectedGoal)
                : "Current focus"}
            </span>
            <strong>{selectedGoal.focusText || "No focus period set"}</strong>
            <button
              className="secondary-button"
              onClick={() => setFocusEditor(true)}
            >
              <Pencil size={14} />
              {selectedGoal.focusText ? "Adjust focus" : "Set focus"}
            </button>
          </div>
          <div className="goal-columns">
            <GoalDefinition
              goal={selectedGoal}
              objectiveTitle={objective?.title}
              timeZone={visibleCatalog.timeZone}
              saving={saving}
              onUpdate={updateResult}
            >
              {progressError && (
                <p className="error-message" role="alert">
                  {progressError}
                  <button
                    className="text-button"
                    onClick={() => void readProgress()}
                  >
                    Retry
                  </button>
                </p>
              )}
              <GoalProgress
                key={selectedGoal.id}
                keyResultId={selectedGoal.id}
                entries={progress}
                nextPage={progressPage}
                loading={progressLoading}
                timeZone={visibleCatalog.timeZone}
                onMore={() => void readProgress(progressPage)}
                onChanged={async () => {
                  clearGoalCatalogCache();
                  await readProgress();
                }}
              />
            </GoalDefinition>
            <div>
              {planError && (
                <p className="error-message" role="alert">
                  {planError}
                  <button
                    className="text-button"
                    onClick={() => void readPlan()}
                  >
                    Retry
                  </button>
                </p>
              )}
              <GoalRelatedTasks
                key={selectedGoal.id}
                keyResultId={selectedGoal.id}
                keyResultTitle={selectedGoal.title}
                plan={plan}
                refreshRevision={refreshRevision + relatedRefreshRevision}
                onOpenTask={onOpenTask}
                onCreateTask={onCreateTask}
                onCompleteTask={onCompleteTask}
              />
            </div>
          </div>
        </>
      )}
      {editor && (
        <GoalEditor
          {...editor}
          year={displayedYear ?? new Date().getFullYear()}
          objectives={visibleCatalog?.objectives ?? []}
          onClose={() => setEditor(undefined)}
          onSaved={goalSaved}
        />
      )}
      {focusEditor && selectedGoal && (
        <GoalFocusEditor
          keyResult={selectedGoal}
          onClose={() => setFocusEditor(false)}
          onSaved={goalSaved}
        />
      )}
    </section>
  );
}
