import { useState, type CSSProperties } from "react";
import { DragDropProvider, DragOverlay, useDraggable } from "@dnd-kit/react";
import { GripVertical } from "lucide-react";
import {
  displayedTitle,
  effectiveArea,
  formattedMinutes,
  taskIndex,
} from "./domain";
import { OutcomeCard } from "./ReviewBoard";
import { PlanningCalendar, shortDay, taskTitle } from "./PlanningCalendar";
import {
  outcomeColor,
  outcomeForTask,
  outcomeSteps,
  planningOutcomes,
} from "./planning-outcomes";
import { pendingStep, predictMove } from "./plan-updates";
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
  } = props;
  const committed = planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed",
  );
  const [area, setArea] = useState<Area | "all">("all");
  const [selectedId, setSelectedId] = useState(committed[0]?.id ?? "");
  const selected = committed.find((task) => task.id === selectedId);
  const shown = committed.filter(
    (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
  );
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  function selectArea(next: Area | "all") {
    setArea(next);
    if (
      next !== "all" &&
      selected &&
      effectiveArea(selected, plan.tasks) !== next
    )
      setSelectedId(
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
            <h2>{words(language).committed}</h2>
            <span>
              {committed.length} {language === "zh" ? "项" : "outcomes"}
            </span>
          </div>
          <div
            className="planning-area-filter"
            role="tablist"
            aria-label={language === "zh" ? "承诺范围" : "Commitment area"}
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
        <div className="planning-commitment-grid">
          {shown.map((task) => (
            <OutcomeCard
              key={task.id}
              task={task}
              tasks={plan.tasks}
              managedLabels={plan.managedLabels}
              scheduledIds={scheduledIds}
              language={language}
              selected={selected?.id === task.id}
              onClick={() =>
                setSelectedId(selectedId === task.id ? "" : task.id)
              }
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
            <div className="planning-tray-steps">
              {outcomeSteps(selected, plan.tasks, plan.managedLabels).map(
                (task) => (
                  <TrayStep
                    key={task.id}
                    task={task}
                    days={days}
                    timer={timer}
                    language={language}
                    busy={busy}
                    editTask={editTask}
                  />
                ),
              )}
            </div>
            {outcomeSteps(selected, plan.tasks, plan.managedLabels).length ===
              0 && (
              <p className="planning-step-tray-empty">
                {words(language).noChildren}
              </p>
            )}
          </section>
        ) : (
          <p className="planning-step-tray-empty">
            {language === "zh"
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
        <GripVertical size={15} />
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
