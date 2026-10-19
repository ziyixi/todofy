import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  DragDropProvider,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { PointerActivationConstraints } from "@dnd-kit/dom";
import { pointerIntersection } from "@dnd-kit/collision";
import { spokenDrags } from "@ziyixi/planning-ui/drag-announcements";
import { Circle, CornerDownRight } from "lucide-react";
import { describeError, type Task } from "../api";
import type { TaskDrop, TaskDropPosition, TaskDropTarget } from "../task-drag";
import "./task-drag.css";

const plugins = spokenDrags("en", (data, as) => {
  if (!data) return;
  const { task, drop } = data as { task?: Task; drop?: TaskDrop };
  if (as === "source") return task?.title;
  if (drop?.kind === "row")
    return `${drop.position === "inside" ? "Under" : drop.position} ${drop.task.title}`;
  if (drop?.kind === "detach") return "Independent task";
  if (drop?.kind === "category") return drop.target.page;
});

const sensors = [
  PointerSensor.configure({
    activatorElements: (source) => [source.element],
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
    preventActivation: (event) =>
      event.target instanceof Element &&
      Boolean(
        event.target.closest(
          "button:not(.task-open):not(.task-child-title):not(.drag-handle):not(.child-drag), input, textarea, select, a[href], [contenteditable=true]",
        ),
      ),
  }),
  KeyboardSensor,
];
const DragContext = createContext<{
  moving?: Task;
  lastMove?: { parentId: string };
}>({});

export function TaskDragProvider({
  children,
  onDrop,
  onError,
}: {
  children: ReactNode;
  onDrop: (task: Task, target: TaskDrop) => Promise<boolean | void>;
  onError: (message: string) => void;
}) {
  const [moving, setMoving] = useState<Task>();
  const [lastMove, setLastMove] = useState<{ parentId: string }>();
  return (
    <DragDropProvider<{ task?: Task; drop?: TaskDrop }>
      sensors={sensors}
      plugins={plugins}
      onDragStart={({ operation }) => setMoving(operation.source?.data.task)}
      onDragEnd={async ({ canceled, operation, suspend }) => {
        const task = operation.source?.data.task;
        const target = operation.target?.data.drop;
        if (canceled || !task || !target) {
          setMoving(undefined);
          return;
        }
        // Keep the preview until the existing write and bounded view refresh have settled.
        const animation = suspend();
        try {
          const changed = await onDrop(task, target);
          if (changed !== false && target.kind === "row")
            setLastMove({
              parentId:
                target.position === "inside"
                  ? target.task.id
                  : target.task.parentId,
            });
          animation.resume();
        } catch (reason) {
          onError(describeError(reason));
          animation.abort();
        } finally {
          setMoving(undefined);
        }
      }}
    >
      <DragContext value={{ moving, lastMove }}>{children}</DragContext>
      <DragOverlay
        style={{ pointerEvents: "none" }}
        dropAnimation={null}
      >
        {(source) =>
          source.data.task ? (
            <div className="task-drag-preview" aria-hidden inert>
              <Circle
                size={18}
                className={`priority-${source.data.task.priority}`}
              />
              <span>{source.data.task.title}</span>
            </div>
          ) : null
        }
      </DragOverlay>
    </DragDropProvider>
  );
}

export function useTaskDrag(task: Task, disabled: boolean) {
  return useDraggable({ id: `task:${task.id}`, data: { task }, disabled });
}

export function useTaskDragState() {
  return useContext(DragContext);
}

function RowDropZone({
  task,
  position,
  peers,
  disabled,
}: {
  task: Task;
  position: TaskDropPosition;
  peers: readonly Task[];
  disabled: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `row:${task.id}:${position}`,
    data: { drop: { kind: "row", task, position, peers } satisfies TaskDrop },
    collisionDetector: pointerIntersection,
    disabled,
  });
  return (
    <span
      ref={ref}
      className={`task-drop-zone drop-${position}${isDropTarget ? " is-over" : ""}`}
      aria-hidden
    >
      {position === "inside" && isDropTarget && (
        <span className="task-drop-hint">
          <CornerDownRight size={12} />
          Move under this task
        </span>
      )}
    </span>
  );
}

export function TaskRowDropZones({
  task,
  peers,
  ancestors = [],
  inside = true,
  busy = false,
}: {
  task: Task;
  peers: readonly Task[];
  ancestors?: readonly string[];
  inside?: boolean;
  busy?: boolean;
}) {
  const { moving } = useTaskDragState();
  const disabled =
    busy || !moving || moving.id === task.id || ancestors.includes(moving.id);
  return (
    <>
      <RowDropZone
        task={task}
        peers={peers}
        position="before"
        disabled={disabled || moving?.kind !== task.kind}
      />
      <RowDropZone
        task={task}
        peers={peers}
        position="inside"
        disabled={disabled || !inside || task.completed || task.kind === "step"}
      />
      <RowDropZone
        task={task}
        peers={peers}
        position="after"
        disabled={disabled || moving?.kind !== task.kind}
      />
    </>
  );
}

export function TaskCategoryLink({
  target,
  children,
  className,
  ...props
}: Omit<ComponentProps<"a">, "target"> & { target?: TaskDropTarget }) {
  const id = useId();
  const { moving } = useTaskDragState();
  const { ref, isDropTarget } = useDroppable({
    id: `category:${id}`,
    data: {
      drop: target
        ? ({ kind: "category", target } satisfies TaskDrop)
        : undefined,
    },
    collisionDetector: pointerIntersection,
    disabled: !target || !moving || moving.kind === "step",
  });
  return (
    <a
      {...props}
      ref={ref}
      className={className}
      data-task-drop={isDropTarget || undefined}
    >
      {children}
    </a>
  );
}

export function TaskDetachZone() {
  const { moving } = useTaskDragState();
  const enabled = Boolean(moving?.parentId && moving.kind !== "step");
  const { ref, isDropTarget } = useDroppable({
    id: "task:detach",
    data: { drop: { kind: "detach" } satisfies TaskDrop },
    collisionDetector: pointerIntersection,
    disabled: !enabled,
  });
  return enabled ? (
    <div
      ref={ref}
      role="region"
      aria-label="Make independent task"
      className={`task-detach-zone${isDropTarget ? " is-over" : ""}`}
    >
      Make independent task<span>Keep its project and dates.</span>
    </div>
  ) : null;
}
