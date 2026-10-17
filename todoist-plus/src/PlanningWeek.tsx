import { useId, type CSSProperties } from "react";
import { DragDropProvider, DragOverlay, useDraggable } from "@dnd-kit/react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import {
  displayedTitle,
  effectiveArea,
  formattedMinutes,
  taskIndex,
} from "./domain";
import { AddStep } from "./AddStep";
import { OutcomeCard } from "./ReviewBoard";
import { PlanningCalendar, shortDay, taskTitle } from "./PlanningCalendar";
import {
  outcomeColor,
  outcomeForTask,
  outcomeSteps,
  planningOutcomes,
} from "./planning-outcomes";
import { pendingStep, predictMove } from "./plan-updates";
import { unscheduledCommitments } from "./weekly-review";
import { words } from "./i18n";
import type {
  Area,
  FlowDayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

interface Props {
  plan: PlanState;
  days: FlowDayPlan[];
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  actions: PlusActions;
  run: RunOperation;
  editTask: (task: PlanningTask) => void;
  onWeekChange: (week: string) => void;
  /** The selected commitment: absent for the first one, "" for none. PlanView keeps it. */
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Week's own area filter, which the weekly review's "Plan steps" resets. */
  area: Area | "all";
  onArea: (area: Area | "all") => void;
  /** Committed folded to its heading line; Next steps stays. */
  folded: boolean;
  onFold: (folded: boolean) => void;
  /** Next steps' Add steps input is open, which the weekly review's Plan steps also opens. */
  addingStep: boolean;
  onAddingStep: (open: boolean) => void;
}
export function PlanningWeek(props: Props) {
  const {
    plan,
    days,
    flowTasks,
    timer,
    currentDate,
    language,
    busy,
    pending,
    actions,
    run,
    editTask,
    onWeekChange,
    selectedId,
    onSelect,
    area,
    onArea,
    folded,
    onFold,
    addingStep,
    onAddingStep,
  } = props;
  const gridId = useId();
  const committed = planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed",
  );
  // One quiet line, not a mark per card: commitments with nothing in these seven days.
  const unplanned = unscheduledCommitments(plan, days);
  // A remembered commitment that is no longer committed falls back to the first one.
  const selected =
    selectedId === ""
      ? undefined
      : (committed.find((task) => task.id === selectedId) ?? committed[0]);
  const shown = committed.filter(
    (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
  );
  const steps = selected
    ? outcomeSteps(selected, plan.tasks, plan.managedLabels)
    : [];
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  function selectNextUnplanned() {
    const index = unplanned.findIndex((task) => task.id === selected?.id);
    const next = unplanned[(index + 1) % unplanned.length]!;
    if (area !== "all" && effectiveArea(next, plan.tasks) !== area)
      onArea("all");
    onSelect(next.id);
  }
  function selectArea(next: Area | "all") {
    onArea(next);
    if (
      next !== "all" &&
      selected &&
      effectiveArea(selected, plan.tasks) !== next
    )
      onSelect(
        committed.find((task) => effectiveArea(task, plan.tasks) === next)
          ?.id ?? "",
      );
  }
  return (
    <DragDropProvider
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        const source = operation.source?.data as
          { taskId?: string; sourceDate?: string } | undefined;
        const target = operation.target?.data as
          { date?: string; beforeId?: string } | undefined;
        const day = days.find((day) => day.date === target?.date);
        if (!source?.taskId || !day || source.taskId === target?.beforeId)
          return;
        const id = source.taskId;
        const from = days.find((day) => day.date === source.sourceDate);
        // The card shows in its new place at once and waits there until FlowDay confirms.
        void run(() => actions.moveTaskToDay(id, from, day, target?.beforeId), {
          pending: [pendingStep(day.date, id)],
          predict: predictMove(id, from?.date, day.date, target?.beforeId),
        });
      }}
    >
      <section
        className="planning-week"
        aria-label={language === "zh" ? "一周安排" : "Weekly planning"}
      >
        <header className="planning-commitment-heading">
          <div>
            <h2>
              <button
                className="planning-committed-toggle"
                aria-expanded={!folded}
                aria-controls={gridId}
                onClick={() => onFold(!folded)}
              >
                {folded ? (
                  <ChevronRight size={16} />
                ) : (
                  <ChevronDown size={16} />
                )}
                {words(language).committed}
              </button>
            </h2>
            <span>
              {committed.length}{" "}
              {language === "zh"
                ? "项"
                : committed.length === 1
                  ? "outcome"
                  : "outcomes"}
            </span>
          </div>
          {/* Folded, the filter and the grid stay mounted, so aria-controls always resolves. */}
          <div
            className="planning-area-filter"
            role="tablist"
            aria-label={language === "zh" ? "承诺范围" : "Commitment area"}
            hidden={folded}
          >
            {(
              [
                "all",
                "work",
                "personal",
                ...(committed.some(
                  (task) => effectiveArea(task, plan.tasks) === "unassigned",
                )
                  ? ["unassigned"]
                  : []),
              ] as (Area | "all")[]
            ).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={area === value}
                onClick={() => selectArea(value)}
              >
                {value === "all"
                  ? language === "zh"
                    ? "全部"
                    : "All"
                  : words(language)[value]}
              </button>
            ))}
          </div>
        </header>
        {unplanned.length > 0 && (
          <button
            className="planning-runway"
            title={language === "zh" ? "选中下一个" : "Select the next one"}
            onClick={selectNextUnplanned}
          >
            {language === "zh"
              ? `${unplanned.length} 项承诺这 7 天还没有安排`
              : `${unplanned.length} ${unplanned.length === 1 ? "commitment has" : "commitments have"} nothing planned in these 7 days`}
          </button>
        )}
        <div id={gridId} className="planning-commitment-grid" hidden={folded}>
          {shown.map((task) => (
            <OutcomeCard
              key={task.id}
              task={task}
              tasks={plan.tasks}
              managedLabels={plan.managedLabels}
              scheduledIds={scheduledIds}
              language={language}
              selected={selected?.id === task.id}
              onClick={() => onSelect(selected?.id === task.id ? "" : task.id)}
            />
          ))}
        </div>
        {selected ? (
          <section
            className="planning-step-tray"
            aria-label={`${words(language).steps}: ${displayedTitle(selected.title)}`}
            style={
              { "--outcome-color": outcomeColor(selected) } as CSSProperties
            }
          >
            <header>
              <div>
                <span>{words(language).steps}</span>
                <strong>{displayedTitle(selected.title)}</strong>
              </div>
              <button onClick={() => editTask(selected)}>
                {words(language).details}
              </button>
            </header>
            {/* Every child has a stage of its own: none is a step here yet. */}
            {steps.length === 0 && (
              <p className="planning-step-tray-empty">
                {words(language).noChildren}
              </p>
            )}
            <div className="planning-tray-steps">
              {steps.map((task) => (
                <TrayStep
                  key={task.id}
                  task={task}
                  days={days}
                  timer={timer}
                  language={language}
                  busy={busy}
                  editTask={editTask}
                />
              ))}
              {/* Keyed by the commitment: another one's selection closes it and drops the draft. */}
              <AddStep
                key={selected.id}
                outcome={selected}
                open={addingStep}
                onOpenChange={onAddingStep}
                busy={busy}
                run={run}
                actions={actions}
                tasks={plan.tasks}
                language={language}
              />
            </div>
          </section>
        ) : (
          <p className="planning-step-tray-empty">
            {folded
              ? words(language).expandToChoose
              : language === "zh"
                ? "选择上面的事项，安排它的小步骤。"
                : "Choose an outcome above to arrange its next steps."}
          </p>
        )}
        <PlanningCalendar
          plan={plan}
          days={days}
          flowTasks={flowTasks}
          timer={timer}
          currentDate={currentDate}
          language={language}
          busy={busy}
          pending={pending}
          editTask={editTask}
          onWeekChange={onWeekChange}
          onRemove={(day, id) =>
            // The card stays, marked pending, until FlowDay confirms the removal.
            void run(() => actions.removeFromDay(id, day.date), {
              pending: [pendingStep(day.date, id)],
            })
          }
        />
      </section>
      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
        {(source) => {
          const id = String(source.data?.taskId ?? "");
          const task = taskIndex(plan.tasks).get(id);
          const outcome = task
            ? outcomeForTask(task, plan.tasks, plan.managedLabels)
            : undefined;
          return (
            <div
              className="planning-step-overlay"
              aria-hidden="true"
              inert
              style={
                {
                  "--outcome-color": outcome
                    ? outcomeColor(outcome)
                    : "var(--plus-muted)",
                } as CSSProperties
              }
            >
              <strong>
                {taskTitle(id, task?.title ?? flowTasks[id]?.title, language)}
              </strong>
              {outcome && <small>{displayedTitle(outcome.title)}</small>}
            </div>
          );
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

function TrayStep({
  task,
  days,
  timer,
  language,
  busy,
  editTask,
}: {
  task: PlanningTask;
  days: FlowDayPlan[];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
}) {
  const timing = timer?.taskId === task.id;
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `tray:${task.id}`,
    type: "planning-step",
    disabled: busy || timing,
    data: { taskId: task.id },
  });
  const scheduled = days.filter(
    (day) =>
      day.taskIds.includes(task.id) && !day.completedTaskIds.includes(task.id),
  );
  const text = words(language);
  return (
    <article
      ref={ref}
      className={`planning-tray-step ${isDragSource ? "is-dragging" : ""}`}
      data-task-id={task.id}
    >
      <button
        ref={handleRef}
        className="planning-drag-handle"
        disabled={busy || timing}
        title={
          timing
            ? language === "zh"
              ? "先结束当前计时再移动"
              : "Stop the current session before moving this step"
            : undefined
        }
        aria-label={`${language === "zh" ? "拖动步骤" : "Drag step"}: ${displayedTitle(task.title)}`}
      >
        <GripVertical size={14} />
      </button>
      <button className="planning-step-title" onClick={() => editTask(task)}>
        <span>{displayedTitle(task.title)}</span>
        <small>
          {task.estimatedMinutes === undefined
            ? text.unknown
            : formattedMinutes(task.estimatedMinutes)}
          {scheduled.length > 0 &&
            ` · ${scheduled.map((day) => shortDay(day.date, language)).join(", ")}`}
        </small>
        {task.estimatedMinutes !== undefined &&
          task.estimatedMinutes >= 120 && (
            <small className="planning-step-warning">{text.longStep}</small>
          )}
      </button>
    </article>
  );
}
