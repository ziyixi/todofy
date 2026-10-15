import { useEffect, useRef, useState } from "react";
import { ExternalLink, Target, X } from "lucide-react";
import {
  displayedTitle,
  effectiveArea,
  taskAncestors,
  topLevelBets,
} from "./domain";
import { TaskBreadcrumb } from "./TaskBreadcrumb";
import { pendingTask } from "./plan-updates";
import { words } from "./i18n";
import type {
  Area,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

interface Props {
  plan: PlanState;
  language: Language;
  busy: boolean;
  /** Tasks whose stage drag waits keep their old etag until it is confirmed. */
  pending?: ReadonlySet<string>;
  run: RunOperation;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  onOpenTask?: (id: string) => void;
}

export function WeeklyGoals({
  plan,
  language,
  busy,
  pending,
  run,
  actions,
  editTask,
  onOpenTask,
}: Props) {
  const [picker, setPicker] = useState<{
    area: Area;
    previous?: PlanningTask;
  }>();
  const unassigned = topLevelBets(plan.tasks, "unassigned");
  const zh = language === "zh";
  const text = words(language);
  const waiting = (task: PlanningTask) =>
    pending?.has(pendingTask(task.id)) ?? false;
  function goal(task: PlanningTask, area: Area) {
    return (
      <div key={task.id} className="plus-weekly-goal">
        <button
          className="plus-weekly-goal-title"
          onClick={() => editTask(task)}
        >
          {displayedTitle(task.title)}
        </button>
        <TaskBreadcrumb task={task} tasks={plan.tasks} language={language} />
        <div className="plus-weekly-goal-actions">
          <button
            disabled={busy || waiting(task)}
            onClick={() => setPicker({ area, previous: task })}
          >
            {zh ? "更换目标" : "Change goal"}
          </button>
          {onOpenTask && (
            <button
              onClick={() => onOpenTask(task.id)}
              aria-label={`${zh ? "在 Todoist 中编辑" : "Edit in Todoist"}: ${displayedTitle(task.title)}`}
            >
              <ExternalLink size={12} />
              {zh ? "编辑内容" : "Edit content"}
            </button>
          )}
          <button
            disabled={busy || waiting(task)}
            aria-label={`${zh ? "移除本周目标" : "Remove weekly goal"}: ${displayedTitle(task.title)}`}
            onClick={() =>
              void run(() => actions.updateTask(task, { bet: false }))
            }
          >
            {zh ? "移除标记" : "Remove mark"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <section
      className="plus-weekly-goals"
      aria-label={zh ? "本周目标" : "Weekly goals"}
    >
      <header>
        <h2>
          <Target size={15} />
          {zh ? "本周目标" : "Weekly goals"}
        </h2>
        <span>
          {zh ? "当前周" : "Week of"} {plan.week}
        </span>
      </header>
      <div className="plus-weekly-goal-grid">
        {(["work", "personal"] as const).map((area) => {
          const goals = topLevelBets(plan.tasks, area);
          return (
            <div key={area} className="plus-weekly-goal-context">
              <h3>{text[area]}</h3>
              {goals.map((task) => goal(task, area))}
              {!goals.length && (
                <button
                  className="plus-weekly-goal-empty"
                  disabled={busy}
                  onClick={() => setPicker({ area })}
                >
                  {zh
                    ? "选择一个本周整体目标"
                    : "Choose an overall goal for this week"}
                </button>
              )}
              {goals.length > 1 && (
                <p className="plus-weekly-goal-warning">
                  {zh
                    ? "标记了多个目标，可按需要逐个调整。"
                    : "More than one goal is marked. Adjust them individually."}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {unassigned.length > 0 && (
        <div className="plus-weekly-goal-unassigned">
          <h3>{zh ? "未分类目标" : "Unassigned goals"}</h3>
          <p>
            {zh
              ? "在任务详情中选择工作或生活；这些目标仍然保留。"
              : "Choose Work or Personal in task details. These goals are still kept."}
          </p>
          {unassigned.map((task) => goal(task, "unassigned"))}
        </div>
      )}
      {picker && (
        <GoalPicker
          plan={plan}
          area={picker.area}
          previous={picker.previous}
          language={language}
          busy={busy}
          waiting={waiting}
          onClose={() => setPicker(undefined)}
          onChoose={async (next) => {
            await run(async () => {
              const confirmed: PlanningTask[] = [];
              if (picker.previous && picker.previous.id !== next.id)
                confirmed.push(
                  await actions.updateTask(picker.previous, { bet: false }),
                );
              if (!next.bet)
                confirmed.push(await actions.updateTask(next, { bet: true }));
              return confirmed;
            });
            setPicker(undefined);
          }}
        />
      )}
    </section>
  );
}

function GoalPicker({
  plan,
  area,
  previous,
  language,
  busy,
  waiting,
  onClose,
  onChoose,
}: {
  plan: PlanState;
  area: Area;
  previous?: PlanningTask;
  language: Language;
  busy: boolean;
  waiting: (task: PlanningTask) => boolean;
  onClose: () => void;
  onChoose: (task: PlanningTask) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(previous?.id ?? "");
  const zh = language === "zh";
  const choices = plan.tasks.filter(
    (task) =>
      effectiveArea(task, plan.tasks) === area &&
      `${displayedTitle(task.title)} ${taskAncestors(task, plan.tasks)
        .map((parent) => displayedTitle(parent.title))
        .join(" ")}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const selected = choices.find((task) => task.id === selectedId);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="plus-dialog plus-goal-picker"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (selected && selected.id !== previous?.id && !waiting(selected))
            void onChoose(selected);
        }}
      >
        <header>
          <h2>
            {zh
              ? "选择现有任务作为本周目标"
              : "Choose an existing task as this week's goal"}
          </h2>
          <button
            type="button"
            className="plus-icon"
            aria-label={zh ? "关闭" : "Close"}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          {zh
            ? "只调整目标标记，不改变承诺、候选或日期。"
            : "This changes the goal mark, preserving planning stages and dates."}
        </p>
        <input
          type="search"
          aria-label={zh ? "搜索目标任务" : "Search goal tasks"}
          placeholder={zh ? "搜索任务或父任务" : "Search tasks or parents"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label={zh ? "目标任务" : "Goal task"}
          size={8}
          value={selectedId}
          disabled={busy}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {choices.map((task) => (
            <option key={task.id} value={task.id}>
              {[
                ...taskAncestors(task, plan.tasks).map((parent) =>
                  displayedTitle(parent.title),
                ),
                displayedTitle(task.title),
              ].join(" › ")}
            </option>
          ))}
        </select>
        {!choices.length && (
          <p>
            {zh
              ? "此分类没有匹配任务。可先在任务详情中设置工作或生活。"
              : "No matching tasks in this context. Set Work or Personal in task details first."}
          </p>
        )}
        <footer>
          <button type="button" className="plus-button" onClick={onClose}>
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="plus-button plus-primary"
            type="submit"
            disabled={
              busy ||
              !selected ||
              selected.id === previous?.id ||
              waiting(selected)
            }
          >
            {zh ? "设为本周目标" : "Use as weekly goal"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
