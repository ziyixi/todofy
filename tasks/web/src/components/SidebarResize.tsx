import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import "./sidebar-resize.css";

const MIN_WIDTH = 200;
const MAX_WIDTH = 360;
const STORAGE_KEY = "tasks.sidebar-width";

export function SidebarResize() {
  const handle = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLElement | null>(null);
  const drag = useRef<
    { pointer: number; x: number; width: number } | undefined
  >(undefined);

  function currentWidth() {
    return (
      Number.parseFloat(
        getComputedStyle(shell.current!).getPropertyValue("--sidebar-width"),
      ) || 245
    );
  }
  function resize(width: number) {
    const bounded = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)));
    shell.current?.style.setProperty("--sidebar-width", `${bounded}px`);
    handle.current?.setAttribute("aria-valuenow", String(bounded));
  }
  function remember() {
    try {
      localStorage.setItem(STORAGE_KEY, String(currentWidth()));
    } catch {
      /* The current window still resizes when browser storage is disabled. */
    }
  }
  useLayoutEffect(() => {
    shell.current = handle.current?.closest<HTMLElement>(".app-shell") ?? null;
    if (!shell.current) return;
    let saved = Number.NaN;
    try {
      saved = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? "");
    } catch {
      /* Browser storage is optional for this layout preference. */
    }
    if (Number.isFinite(saved)) resize(saved);
    else handle.current?.setAttribute("aria-valuenow", String(currentWidth()));
    return () => {
      shell.current?.classList.remove("sidebar-resizing");
    };
  }, []);

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || window.innerWidth <= 760 || !shell.current)
      return;
    event.preventDefault();
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      width: currentWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    shell.current.classList.add("sidebar-resizing");
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (start?.pointer === event.pointerId)
      resize(start.width + event.clientX - start.x);
  }
  function finish() {
    if (!drag.current) return;
    drag.current = undefined;
    shell.current?.classList.remove("sidebar-resizing");
    remember();
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !["ArrowLeft", "ArrowRight"].includes(event.key) ||
      window.innerWidth <= 760 ||
      !shell.current
    )
      return;
    event.preventDefault();
    resize(
      currentWidth() +
        (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 1 : 10),
    );
    remember();
  }
  return (
    <div
      ref={handle}
      className="sidebar-resize"
      role="separator"
      aria-label="Resize navigation"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={245}
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={keyboard}
    />
  );
}
