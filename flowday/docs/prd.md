# FlowDay — Product Requirements Document

> Imported from the standalone `ziyixi/FlowDay` repository. The product sections (1–5, 11–12) still
> describe FlowDay; the tech stack, project structure, Docker deployment and build sessions (6–10)
> describe the pre-monorepo app. Paths such as `PRD/`, `docs/` and the root config files now live in
> `flowday/docs/` and `flowday/web/`; see [`../README.md`](../README.md) for the current state.

**A visual daily task flow planner with Todoist integration**
*Spiritual successor to HourStack, rebuilt for the modern solo productivity stack*

---

## 1. Problem Statement

HourStack was acquired by ClickUp and discontinued as a standalone product. It left behind a gap for users who loved its core workflow: **pull tasks from Todoist → visually arrange them into a day plan → execute sequentially → track what actually happened**. No current tool replicates this well. Sunsama is close but costs $16/mo and overcomplicates things. What's needed is a lean, beautiful, open-source alternative you fully own.

### The Core Insight (What Made HourStack Special)

Most time-blocking apps force you to assign exact clock times to tasks. But knowledge work doesn't work that way — you don't know if the 2pm meeting will run long, or if you'll get into flow state on the morning coding task. **FlowDay embraces sequential ordering over clock-time scheduling.** You decide *what* to do today and *in what order*, then simply work through the list. The app tracks how long each task actually takes, building data over time.

---

## 2. Target User

Solo knowledge workers (developers, designers, writers, consultants) who already use Todoist as their task inbox and want a daily execution layer on top. Not teams — keep it personal and fast.

---

## 3. Core Concepts

| Concept | Description |
|---------|-------------|
| **Task Pool** | Sidebar showing Todoist tasks (today + overdue). Future-dated tasks are synced but hidden until their due date arrives. |
| **Day Flow** | The main canvas — an ordered list of tasks you've committed to today. Not time-slotted, just sequenced. |
| **Active Task** | The task you're currently working on. One at a time. Timer runs automatically. |
| **Time Entry** | A recorded span: which task, start time, end time, duration. Builds your history. |
| **Day View / Multi-Day View** | Toggle between focusing on today vs. seeing a 3-day or 5-day horizon. |

---

## 4. Feature Breakdown

### 4.1 — Todoist Sidebar (Task Pool) ✅ Implemented

**What it does:** Syncs with Todoist and shows tasks in a collapsible sidebar panel.

- Authenticate via Todoist personal API token (entered in Settings dialog)
- Display tasks grouped by: Arranged (current day's flow), Completed (current day's completed), Today, Overdue
- Each task card shows: title, priority color dot, project name, estimated duration (click-to-edit), description tooltip on hover
- Drag a task from the sidebar → drop into the Day Flow
- Tasks are *read-only* from Todoist — FlowDay never writes to the Todoist API
- Tasks can be soft-deleted (hidden) locally via a trash icon on each sidebar card; deleted tasks are never removed from DB and never sync back to Todoist
- Deleted tasks are browsable via a calendar-based trash dialog (trash icon in sidebar header), grouped by deletion date, with search and restore functionality
- Todoist sync never resurrects soft-deleted tasks
- Estimated duration is locally editable (click the estimate on any task card to change it; persisted to SQLite)
- Task description synced from Todoist; rendered as Markdown tooltip on hover in sidebar (via `react-markdown`)
- "Refresh" button (sidebar header) + auto-sync every 60 seconds
- Search/filter within the sidebar
- Fetches all active tasks from Todoist (via `GET /api/v1/tasks`); sidebar filters to today + overdue, future-dated tasks stay in DB and reappear when their due date arrives
- **Arranged list:** Shows tasks added to the current day's flow (primary accent), non-draggable summary
- **Completed list:** Shows tasks completed in the current day's flow with logged time + estimated time
- **Quick add:** Inline input at top of sidebar to create local tasks (no Todoist required). Local tasks get `local-<uuid>` IDs, today's due date, and are editable inline
- **Editable titles:** Local tasks (non-Todoist) show a pencil icon on hover to edit the title inline in both sidebar and flow cards

**Implementation notes:**
- Todoist API v1 (`/api/v1/tasks`, `/api/v1/projects`) with cursor-based pagination
- Fetches task `content` (title) and `description` from Todoist API
- API key stored in SQLite `settings` table, entered via Settings dialog in top bar
- Tasks persisted in SQLite `tasks` table — survive page refresh
- `estimated_mins` editable locally via `PATCH /api/tasks` — Todoist sync preserves local edits only when Todoist has no duration set
- `POST /api/tasks` creates local tasks; `PATCH /api/tasks` supports both `estimatedMins` and `title` updates
- Zustand store (`todoist-store`) acts as reactive cache, hydrated from SQLite on load; `addLocalTask` and `updateTitle` actions for local task management
- Color mapping: Todoist color names (e.g., `berry_red`) → hex values (20 colors supported)
- Task labels shown in hover tooltip alongside description
- Tasks labeled `quick` are separated from ordinary Today/Overdue task cards into a quieter Quick section. They remain visible as lightweight rows with editable individual estimates, while a single draggable `Quick` placeholder shows the summed estimate and can be arranged in the day flow instead of giving each quick item its own full block.

### 4.2 — Day Flow (Main Canvas) ✅ Implemented

**What it does:** An ordered, drag-reorderable list of tasks for the day.

- Drag to reorder tasks within the flow
- Each task card shows: title, project name, labels, estimated duration (click-to-edit via `EstimateEditor` popover), actual time (when timer runs), priority color dot
- Each card has action buttons: play/pause (timer), manual time entry (clock icon), complete (check), skip (move to bottom), remove (return to pool)
- The top card is visually highlighted as "Next" with a primary-color left border and badge
- The synthetic `Quick` placeholder is arrangeable like a flow item, but uses a quieter treatment and requires selecting a real quick task before timer, Pomodoro, completion, or manual time actions record work. Its individual quick-task list is collapsed by default, can be expanded for selection, and keeps each quick task's estimate editable; statistics attribute work to the selected quick task, not to the placeholder.
- Drag-sortable within the flow using unique sortable IDs (`date::taskId::sortableKey`) for dnd-kit stability
- Visual progress bar at the bottom: tasks completed vs. total, total estimated time vs. actual logged time
- Completed tasks shown in a dimmed section with undo button, showing both estimated and actual logged time

**Multi-day view (3-day, 5-day):**
- Horizontal columns for each day with compact read-only task cards
- Toggle via 1/3/5 buttons in top bar
- Date navigation with prev/next buttons and "Today" shortcut

**Persistence:**
- Flow assignments (task order per date) persisted in SQLite `flow_tasks` table
- Completed task assignments persisted in SQLite `completed_flow_tasks` table
- Write-through: Zustand updates optimistically, then fire-and-forget API call to persist
- `sortableGen` counter + `sortableKeys` map in flow store prevent stale dnd-kit state on re-add

### 4.3 — Time Tracking ✅ Implemented

**Segment-based count-up timer:**
- Timer starts when you click play on a task, shows elapsed time on the card and in sidebar/top bar
- Pause saves the current running segment as a `time_entry` and stops the clock
- Resume starts a new segment — each pause/resume creates a separate time entry for accuracy
- Complete stops timer + saves + marks task complete in flow
- Only one task can have an active timer at a time; switching auto-saves the previous

**Pomodoro mode:**
- Hourglass icon on each flow card opens a preset picker: 5m, 30m, 45m, 1h, 1h 30m, 2h
- Selecting a preset starts a countdown timer that displays time *remaining* instead of elapsed
- When the timer reaches zero it auto-saves the full segment and clears the active state
- A gentle G5–E5–C5 NBC-style chime plays exactly once on completion (sawtooth fundamentals through a `DynamicsCompressor` for loudness, ~0.8s release per note). The sound is engineered to cut through background music; it never plays for count-up timers
- The same active-timer rules apply: starting a pomodoro replaces any other running timer

**Pop-out timer:**
- Document Picture-in-Picture window (`window.documentPictureInPicture.requestWindow`) that floats above other apps
- Shows the active task title, mode badge, large countdown/elapsed, pause/resume + complete buttons, and a subtle "Next: …" line so you can see what's queued without leaving the focus surface
- When the active task completes, the window switches to an "Up next" view with a single Start button for the next queued task
- Auto-opens when a pomodoro starts (the picker click is the user gesture that satisfies the PiP gesture requirement)
- Styles are copied from the main document at open; a `MutationObserver` keeps the dark-mode class in sync
- Pop-out window state lives in a dedicated `pop-out-store` (Zustand) so any component can request opening without prop drilling

**Auto-idle pause:**
- Long-running timers automatically pause when the user is away from the screen for ≥ 10 minutes
- Preferred signal: **Idle Detection API** (`window.IdleDetector`) — gives true screen-lock detection (`screenState === "locked"`) and OS-level idle-input detection (no keyboard/mouse for the threshold). Requires one user grant of the `idle-detection` permission. A small banner appears on the first FlowDay visit asking the user to allow it
- Fallback signal (Safari/Firefox or denied permission): Page Visibility on **both** the main window and the pop-out window — only counts as "away" when both surfaces are hidden simultaneously, so background tabs while pop-out is open never falsely pause
- The pause is **backdated** to the moment the user became hidden (or `now − threshold` for the IdleDetector idle case), so the away interval is never logged as work time — `pauseTimer(effectiveStopMs?)` accepts an optional override for this

**Manual time entry:**
- Clock icon on each flow task card opens a popover showing all time entries for that task
- Each entry shows: date, time range (HH:mm – HH:mm), duration, source (timer/manual)
- Add new entries via dialog with datetime-local inputs
- Edit existing entries via dialog
- Delete entries
- Entries display across all dates (not scoped to current day)

**Timer display locations:**
- Flow task card: shows live elapsed when active, cumulative logged time when inactive
- Top bar: `TimerDisplay` component with task name, elapsed, pause/complete buttons + the pop-out entry-point button (visible only while a timer is active)
- Sidebar: `SidebarTimer` with task name, elapsed, pause/play toggle
- Pop-out window: standalone PiP surface (see Pop-out timer above)

**Implementation notes:**
- Segment-based model: `segmentWallStart` (ISO) + `segmentStartedAt` (Date.now()) for wall-clock accuracy
- `setInterval` at 1Hz, module-level `intervalId` (not in Zustand — not serializable)
- Pomodoro completion path: `tick()` checks `pomodoroRemainingSeconds(state) <= 0`, fires `playCompletionChime()`, saves the remaining segment, then resets state
- Time entries stored in SQLite `time_entries` table via `/api/entries` routes
- `{ cache: "no-store" }` on all fetch calls to avoid Next.js response caching
- `entryRevision` counter in timer store bumped on segment saves, triggers UI refresh of time entry lists
- E2E test bridge (`window.__FLOWDAY_E2E__`) exposes deterministic timer and pop-out helpers only in `E2E_TEST_MODE=1` builds; production builds do not include the bridge or `/api/test/*` seed routes

### 4.4 — Day View / Multi-Day View ✅ Implemented

**Single Day View:**
- Full focus on today's flow. Larger task cards with all action buttons, prominent timer, "Next" indicator.

**Multi-Day View (3-day or 5-day):**
- Horizontal columns with day headers (day-of-week + date)
- Compact read-only task cards (no timer controls, no drag)
- Progress bar per column
- Past/future days visible for planning context

**Toggle:** 1/3/5 buttons in top bar center section. Date navigation with chevrons + "Today" button.

### 4.5 — Settings & Data Export ✅ Implemented

- Settings dialog accessible from gear icon in top bar
- Todoist API key input (password field) with Save button
- "Sync Now" button with spinning indicator
- Last sync timestamp display
- Guidance text: where to find the API key, read-only assurance
- Daily work capacity setting (hours input, default 6h, stored as `day_capacity_mins` in SQLite settings)
- **Data export:** Export button opens a sub-dialog to download time entries or flow history as CSV/JSON with configurable date range
- Export API: `GET /api/export?type=entries|flows&format=csv|json&start=YYYY-MM-DD&end=YYYY-MM-DD`

### 4.6 — Roll-over & Day Capacity ✅ Implemented

**Roll-over:**
- On opening FlowDay for a new day, a prompt appears if yesterday has incomplete tasks: "You have N unfinished tasks from yesterday — roll over or dismiss?"
- "Roll over to today" button moves all incomplete tasks from yesterday to the top of today's flow (preserving order, deduped)
- Rolled-over tasks are removed from yesterday's flow
- Prompt is dismissable and doesn't re-appear once dismissed
- Roll-over prompt shown in both empty and non-empty day flow states

**Day Capacity Warning:**
- Configurable daily work-hours budget in Settings (default: 6h of focused work)
- Progress bar shows total estimated time vs. capacity (e.g., `~3h est / 6h cap`)
- When total estimates exceed capacity, amber warning: "You've planned ~8h 30m for a 6h day"
- Capacity stored reactively in flow store (`dayCapacityMins`) — updates instantly when saved in Settings
- Non-blocking — just an awareness nudge, not a hard limit

**Implementation notes:**
- `day_capacity_mins` stored in SQLite `settings` table, fetched during flow store hydration
- `PUT /api/flows` supports `rollover` action: moves incomplete tasks from `fromDate` to top of `toDate` flow
- `PUT /api/settings` accepts `day_capacity_mins` alongside `todoist_api_key`
- Flow store `dayCapacityMins` field + `setDayCapacityMins` action for reactive UI updates

### 4.7 — Daily Planning Ritual ("Start My Day") ✅ Implemented

**What it does:** A guided 3-step wizard when opening FlowDay each morning to set up the day's plan.

- Triggered automatically when today's flow is empty and planning not yet completed (waits for store hydration)
- Also available via "Plan My Day" button in the empty day-flow state (always visible for today)
- Step 1: Add tasks from the Todoist pool — shows overdue + selected-date tasks with "+" buttons, plus an add-all shortcut when multiple tasks are available
- Step 2: Review plan — numbered task list with inline estimate editors and remove buttons
- Step 3: Confirm — capacity summary with progress bar, over-capacity warning, and the "Start My Day" action
- Dismissable at any step via "×" button — sets planning as completed to prevent re-triggering
- Stores `planning_completed:<date>` flag in SQLite settings table, loaded during hydration
- Rollover support still exists at the API/store layer (`rollover` and `rolloverSelected`) for future UI use, but the current shipped wizard does not expose a rollover step

**Implementation notes:**
- New component: `planning-wizard.tsx` — 3 sub-components (StepAddTasks, StepReview, StepConfirm)
- `PUT /api/flows` supports both `rollover` and `rolloverSelected` actions for store/API-level task carryover flows
- `GET /api/settings?today=YYYY-MM-DD` returns `planning_completed_today: boolean` — client passes its local date to avoid server timezone mismatch
- `PUT /api/settings` accepts `planning_completed_date` to persist the flag
- Flow store additions: `hydrated: boolean`, `planningCompletedDates: Record<string, boolean>`, `setPlanningCompleted(date)`, `rolloverSelectedTasks(from, to, ids)`
- Auto-trigger uses `useEffect` with hydration + date dependencies; all "today" comparisons use `date-fns format()` (local time), never `toISOString()` (UTC)

### 4.8 — Task Notes / Session Log ✅ Implemented

**What it does:** Per-task-per-day text notes for capturing context while working.

- Small expandable text area on each flow task card (StickyNote icon to toggle)
- Jot notes during execution: "blocked on API response," "need to follow up with X," "found a related bug in auth module"
- Notes are scoped to `(task_id, flow_date)` — same task on different days gets separate notes
- Notes visible in the completed tasks section and in multi-day read-only view
- New DB table: `flow_task_notes (id, task_id, flow_date, content, updated_at)` with UNIQUE(task_id, flow_date)
- Useful for daily review / weekly review: "what did I actually do and learn?"
- Auto-saves via debounced (500ms) PUT to `/api/notes`
- Notes auto-expand if content exists when card mounts
- `onMouseDown stopPropagation` on textarea prevents dnd-kit drag interference
- Read-only views show truncated note text with StickyNote icon indicator

### 4.9 — Analytics & Weekly Review Dashboard ✅ Implemented

**Daily Review Panel (accessible via BarChart3 icon in top bar):**
- Summary cards: Tasks Done (completed/planned), Productive Time, Estimated Time, Estimation Accuracy %
- Capacity usage bar: logged time vs. day capacity with amber warning when exceeded
- Per-task breakdown: horizontal bar chart comparing estimated vs. actual time per task
- Completed tasks shown with line-through styling

**Weekly Review (tab toggle in analytics dialog):**
- Summary cards: Total Tasks Done, Total Hours, Avg Tasks/Day, Overall Estimation Accuracy %
- Daily trend: vertical bar chart showing logged minutes per day of the week (Mon–Sun)
- Time by project: horizontal bars with project colors, showing logged time + task count per project
- Stuck work: tasks that appeared in flows on 2+ different dates during the week but were never completed
- Estimation accuracy table: per-task estimated vs. actual with color-coded accuracy (green ≥80%, amber ≥50%, red <50%)

- Data sourced from existing `time_entries`, `flow_tasks`, and `completed_flow_tasks` tables — no new data collection needed
- API route: `GET /api/analytics?type=daily&date=YYYY-MM-DD` and `GET /api/analytics?type=weekly&date=YYYY-MM-DD`
- Pure CSS/Tailwind visualizations (no charting library dependency)
- New analytics query helpers: `getEntriesInDateRange`, `getFlowTaskIdsInDateRange`, `getCompletedTaskIdsInDateRange`, `getTasksByIds`

### 4.10 — Additional Features

- **Quick Add:** ✅ Local tasks created via inline input in sidebar. `POST /api/tasks` creates with `local-<uuid>` ID. Titles editable inline for local tasks only (pencil icon on hover).
- **Export:** ✅ CSV/JSON export of time entries and flow history via `GET /api/export`. Export dialog in Settings with data type, date range, and format selectors.
- **Todoist write-back:** Not planned. FlowDay stays read-only; Todofy is the only Todoist writer.
- **Estimate presets:** ✅ The `EstimateEditor` component provides 30m, 45m, 1h, 1.5h, 2h, 2.5h, 3h presets plus custom minute input and clear
- **PWA:** ✅ Installable progressive web app with service worker, web manifest, and app icons. **All PWA assets live under the `/pwa/*` URL prefix** (`app/pwa/sw/route.ts`, `app/pwa/manifest.webmanifest/route.ts`, `public/pwa/*` for icons + `sw.js` source) so a single bypass policy can be configured in Cloudflare Access (or similar zero-trust proxies) without exposing the rest of the app. The SW is registered with `{ scope: '/' }` and the route returns `Service-Worker-Allowed: /` so it can still control the entire origin. Network-first for navigation and API calls, stale-while-revalidate for static assets. Service worker only registered in production (dev mode auto-unregisters stale workers).

---

## 5. What FlowDay is NOT

- Not a full project management tool (Todoist handles that)
- Not a team collaboration tool (no shared views, no resource allocation)
- Not a calendar app (no clock-time slots, no meeting integration in v1)
- Not a strict Pomodoro app — pomodoro mode is offered as an optional focus block, but FlowDay's core model is continuous segment-based tracking rather than enforced 25/5 cycles

---

## 6. Tech Stack (Actual)

### Frontend

| Layer | Choice | Notes |
|-------|--------|-------|
| **Framework** | **Next.js 16.2.3 (App Router)** | Turbopack, file-based routing |
| **UI Library** | **shadcn/ui v4 + Tailwind CSS v4** | Uses `@base-ui/react` (NOT Radix) |
| **Drag & Drop** | **@dnd-kit/react 0.3.2** | `useDraggable`, `useSortable`, `useDroppable`, `DragDropProvider` |
| **State Management** | **Zustand v5** | Reactive cache layer; SQLite is source of truth |
| **Icons** | **Lucide React** | Clean, consistent icon set |
| **Date/Time** | **date-fns v4** | Tree-shakeable, functional API |
| **Markdown** | **react-markdown v10** | Renders task descriptions in tooltips |
| **Animations** | **tw-animate-css** | Tailwind animation utilities |
| **Variants** | **class-variance-authority** | Component variant utility (cva) |

### Backend & Data

| Layer | Choice | Notes |
|-------|--------|-------|
| **Database** | **SQLite via better-sqlite3** | Local-first, WAL mode, `globalThis` singleton for HMR |
| **ORM** | **Drizzle ORM** | Type-safe schema + queries |
| **API Layer** | **Next.js Route Handlers** | `/app/api/*` routes for all CRUD |
| **Auth (Todoist)** | **Personal API token** | Stored in SQLite settings table |

### Testing

| Layer | Choice | Notes |
|-------|--------|-------|
| **Test Runner** | **Vitest 3.2** | Fast, ESM-native, shared Vite config |
| **Test Structure** | Unit + Integration + UI | `__tests__/unit/`, `__tests__/integration/`, and `__tests__/ui/` |
| **UI Harness** | **Playwright** | Runs under `TZ=UTC`; `E2E_TEST_MODE=1` enables `/api/test/*` seed routes and the E2E browser bridge |
| **Visual Goldens** | **Playwright + pixelmatch-style budget** | README screenshots and broader UI goldens use deterministic seed states, fixed viewport/time, and small diff budgets for renderer drift |
| **DB Isolation** | Fresh SQLite per test | `beforeEach` closes connection + wipes DB file |

### Deployment

| Layer | Choice | Notes |
|-------|--------|-------|
| **Container** | **Docker (multi-stage)** | Node 24 Alpine, standalone Next.js output |
| **Registry** | **GitHub Container Registry** | `ghcr.io`, pushed on main push and release |
| **CI/CD** | **GitHub Actions** | Lint, typecheck, unit/integration/UI tests, README screenshots, UI goldens, build, then Docker push when runtime-relevant files changed |

### Key Architecture Decisions

- **SQLite as source of truth**: Tasks, flows, time entries, settings all in SQLite. Zustand stores are reactive cache only.
- **Read-only Todoist**: FlowDay only reads from Todoist API, never writes. Syncs all active tasks (not just today/overdue) so rescheduled tasks get their updated dueDate and reappear on the correct day with all FlowDay data intact.
- **Write-through persistence**: UI mutations update Zustand optimistically, then fire-and-forget API calls to persist to SQLite.
- **Segment-based timer**: Each pause saves a separate time entry for the actual running segment, ensuring accurate time tracking.
- **Dev-mode fresh DB**: `predev` script wipes SQLite on `npm run dev`; production persists.
- **`serverExternalPackages: ["better-sqlite3"]`** in next.config.ts for native addon support.
- **Standalone output**: `output: "standalone"` in next.config.ts for minimal Docker images.
- **Production/test decoupling**: Test-only API routes use `route.e2e.ts` and are recognized only when `E2E_TEST_MODE=1`. The E2E browser bridge lives under `features/testing` and is dynamically imported only in E2E builds. Docker runs a prune verifier that removes or fails on docs, markdown, source maps, DB files, and test-only markers in `.next/standalone`.
- **Client-authoritative timezone**: All "what day is today?" logic runs in the browser or is passed from the browser via query params. Server never guesses the user's timezone — safe for VPS deployment in any timezone.

---

## 7. Project Structure (Actual)

```
flowday/
├── app/
│   ├── layout.tsx                 # Root layout, providers, theme metadata
│   ├── page.tsx                   # AppShell entry point
│   ├── globals.css                # Tailwind CSS v4 theme + global styles
│   ├── pwa/
│   │   ├── manifest.webmanifest/route.ts # PWA web manifest
│   │   └── sw/route.ts            # Service worker route for standalone compat
│   └── api/
│       ├── analytics/route.ts     # GET daily/weekly/all-time analytics aggregation
│       ├── entries/route.ts       # POST create, GET query time entries
│       ├── entries/[id]/route.ts  # PUT update, DELETE time entry
│       ├── export/route.ts        # GET CSV/JSON export of entries or flows
│       ├── flows/route.ts         # GET all flows, PUT flow mutations
│       ├── notes/route.ts         # GET/PUT task notes (per task+date)
│       ├── settings/route.ts      # GET/PUT settings (accepts ?today= for timezone-safe planning check)
│       ├── sync/route.ts          # POST trigger Todoist sync
│       ├── tasks/route.ts         # GET all, POST create local, PATCH estimate/title, DELETE soft-delete
│       ├── tasks/deleted/route.ts # GET deleted tasks, POST restore
│       ├── timer/session/route.ts # Server-backed active timer continuity
│       └── test/*/route.e2e.ts    # Seed/reset helpers, only included when E2E_TEST_MODE=1
├── features/
│   ├── analytics/
│   │   ├── components/            # Dashboard tabs, daily/weekly review, shared chart UI
│   │   ├── hooks/                 # Analytics resource fetching
│   │   ├── services/              # Analytics route service
│   │   └── contracts.ts           # API payload contracts
│   ├── flow/
│   │   ├── components/            # Editable/read-only day flow, task cards, progress bar
│   │   ├── planning/              # 3-step planning wizard
│   │   ├── services/              # Flow and note route services
│   │   └── store/                 # Zustand flow store + persistence helpers
│   ├── layout/
│   │   ├── app-shell.tsx          # DragDropProvider + sidebar + canvas + optional E2E bridge
│   │   ├── top-bar.tsx            # Date nav, view toggle, timer, analytics, settings
│   │   ├── sidebar.tsx            # Collapsible sidebar with timer + search + task pool
│   │   └── multi-day-flow-columns.tsx
│   ├── settings/
│   │   ├── components/            # Settings + export dialogs
│   │   ├── hooks/                 # Idle permission status
│   │   └── services/              # Settings/export route services
│   ├── tasks/
│   │   └── services/              # Task route service
│   ├── testing/
│   │   ├── client/flowday-e2e-bridge.ts # Browser bridge, E2E-only dynamic import
│   │   └── server/e2e-data.ts     # Seed/reset helpers, guarded by E2E_TEST_MODE
│   ├── timer/
│   │   ├── components/            # Manual entry UI and timer dialog pieces
│   │   ├── services/              # Entries + timer-session route services
│   │   └── store/                 # Timer Zustand store + persistence helpers
│   └── todoist/
│       ├── services/              # Todoist sync service
│       └── store/                 # Todoist task cache + persistence helpers
├── components/
│   ├── shared/
│   │   ├── editable-local-title.tsx
│   │   ├── estimate-editor.tsx    # Reusable estimate popover (presets + custom)
│   │   └── idle-permission-prompt.tsx
│   ├── timer/                     # Timer display, misc time, Pomodoro picker, pop-out surface
│   ├── todoist/                   # Sidebar task cards, task pool, quick add, deleted dialog
│   ├── theme-provider.tsx
│   └── ui/                        # shadcn/ui components (base-ui/react, base-nova style)
│       ├── button.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── label.tsx
│       ├── popover.tsx
│       ├── separator.tsx
│       ├── sheet.tsx
│       ├── toggle.tsx
│       ├── tooltip-icon-button.tsx
│       └── tooltip.tsx
├── lib/
│   ├── db/
│   │   ├── index.ts               # DB connection singleton
│   │   ├── queries.ts             # CRUD and analytics query helpers
│   │   └── schema.ts              # Drizzle schema
│   ├── hooks/
│   │   ├── use-hydration.ts       # Load tasks + flows from SQLite on mount
│   │   └── use-auto-sync.ts       # 1-minute Todoist sync interval
│   ├── stores/
│   │   └── pop-out-store.ts       # Pop-out window request/state coordination
│   ├── todoist/
│   │   ├── api.ts                 # Todoist API client (read-only, paginated)
│   │   └── colors.ts              # Todoist color name -> hex mapping
│   ├── types/
│   │   └── task.ts                # Task interface + priority config
│   ├── utils/
│   │   ├── date.ts                # Date helpers
│   │   └── time.ts                # formatDuration, formatElapsed
│   └── utils.ts                   # cn() utility
├── __tests__/
│   ├── setup.ts                   # Per-test DB isolation (close + wipe)
│   ├── unit/                      # Query helpers, timers, stores, Todoist client/sync, docs sync guards
│   ├── integration/               # Route handlers: entries, flows, notes, settings, sync, export, analytics, timers
│   └── ui/                        # Playwright specs + seeded helpers for wizard, shell/flow, and timer journeys
├── docs/
│   ├── readme/                    # Committed README screenshot goldens
│   └── ui-goldens/                # Broader committed UI visual goldens
├── scripts/
│   ├── check-refactor-imports.sh  # Import boundary guard
│   ├── generate-readme-screenshots.mjs
│   ├── generate-ui-goldens.mjs
│   └── prune-production-standalone.mjs # Docker/prod standalone leak guard
├── .github/
│   └── workflows/
│       └── ci.yml                 # CI/CD: checks, screenshot goldens, build, Docker push
├── public/
│   ├── sw.js                      # Service worker source (served via app/pwa/sw/route.ts)
│   ├── icon.svg                   # App icon (SVG source)
│   ├── icon-192x192.png           # PWA icon 192px
│   ├── icon-512x512.png           # PWA icon 512px
│   ├── icon-maskable-512x512.png  # Maskable PWA icon
│   └── apple-touch-icon.png       # iOS home screen icon
├── db/
│   └── flowday.db                 # SQLite database (gitignored)
├── .dockerignore                  # Excludes node_modules, .next, db, tests, docs
├── .gitignore                     # Includes /db/, *.db, *.db-journal, *.db-wal
├── Dockerfile                     # Multi-stage: deps → build → standalone runner
├── vitest.config.ts               # Vitest config with @ alias + serial execution
├── AGENTS.md                      # Agent rules for Next.js 16 breaking changes
├── CLAUDE.md                      # Claude AI coding instructions
├── README.md
├── next.config.ts                 # standalone output + E2E-only page extension gating
├── tsconfig.json
├── eslint.config.mjs
├── postcss.config.mjs
├── components.json                # shadcn/ui v4 config (base-nova style)
└── package.json
```

---

## 8. Database Schema (Actual)

```sql
-- Tasks: synced from Todoist, cached locally
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,     -- Todoist task ID
  todoist_id      TEXT,                 -- Same as id for synced tasks
  title           TEXT NOT NULL,
  description     TEXT,                 -- Todoist task description
  project_name    TEXT,
  project_color   TEXT,                 -- Hex color
  priority        INTEGER NOT NULL DEFAULT 1,
  labels          TEXT DEFAULT '[]',    -- JSON string[]
  estimated_mins  INTEGER,
  is_completed    INTEGER NOT NULL DEFAULT 0,
  completed_at    TEXT,
  due_date        TEXT,                 -- YYYY-MM-DD
  created_at      TEXT,
  synced_at       TEXT,                 -- Last sync timestamp
  deleted_at      TEXT,                 -- Soft-delete timestamp (NULL = active)
  deleted_source  TEXT                  -- 'sync' when Todoist stopped returning it, 'local' or NULL when user-hidden
);

-- Settings: key-value store (API keys, preferences)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Flow assignments: which tasks are planned for which day, in what order
CREATE TABLE flow_tasks (
  id         TEXT PRIMARY KEY,
  flow_date  TEXT NOT NULL,             -- YYYY-MM-DD
  task_id    TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(flow_date, task_id)
);

-- Completed flow tasks: tasks marked complete within a day's flow
CREATE TABLE completed_flow_tasks (
  id        TEXT PRIMARY KEY,
  flow_date TEXT NOT NULL,
  task_id   TEXT NOT NULL,
  UNIQUE(flow_date, task_id)
);

-- Time entries: the core data FlowDay owns
CREATE TABLE time_entries (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  flow_date   TEXT NOT NULL,
  start_time  TEXT NOT NULL,            -- ISO 8601
  end_time    TEXT,                     -- NULL if still running
  duration_s  INTEGER,                  -- Computed on stop
  source      TEXT NOT NULL DEFAULT 'timer',  -- 'timer' | 'manual'
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Per-task notes scoped to a specific flow date
CREATE TABLE flow_task_notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  flow_date  TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, flow_date)
);

-- Singleton active timer session for reload and cross-device continuity
CREATE TABLE active_timer_session (
  id                              TEXT PRIMARY KEY, -- 'main'
  task_id                         TEXT,
  flow_date                       TEXT,
  status                          TEXT NOT NULL DEFAULT 'idle',
  timer_mode                      TEXT NOT NULL DEFAULT 'countup',
  pomodoro_target_s               INTEGER,
  segment_wall_start              TEXT,
  session_saved_s                 INTEGER NOT NULL DEFAULT 0,
  pomodoro_finished_task_id       TEXT,
  pomodoro_finished_flow_date     TEXT,
  pomodoro_finished_target_s      INTEGER,
  updated_at                      TEXT DEFAULT (datetime('now'))
);
```

---

## 9. Data Flow Architecture

```
┌─────────────────────────────────────────────────────┐
│                    TODOIST CLOUD                     │
│  (Source of truth for tasks — read-only access)      │
└─────────────┬───────────────────────────────────────┘
              │ GET /api/v1/tasks
              │ GET /api/v1/projects
              ▼
┌─────────────────────────────────────────────────────┐
│              FLOWDAY API LAYER                      │
│  Next.js Route Handlers                             │
│  POST /api/sync → fetch Todoist + upsert SQLite     │
│  GET /api/tasks → read tasks from SQLite            │
│  GET/PUT /api/flows → read/write flow assignments   │
│  GET/PUT /api/settings → API key management         │
│  CRUD /api/entries → time entry management          │
│  GET /api/analytics + /api/export → review/export   │
└─────────────┬───────────────────────┬───────────────┘
              │                       │
              ▼                       ▲
┌─────────────────────────────────────────────────────┐
│           SQLite (source of truth)                   │
│  tasks, settings, flow_tasks, completed_flow_tasks, │
│  time_entries                                        │
└─────────────┬───────────────────────┬───────────────┘
              │                       │
              ▼                       ▲
┌─────────────────────────────────────────────────────┐
│          Zustand Stores (reactive cache)             │
│  todoist-store: task cache + sync orchestration      │
│  flow-store: flow assignments + planning state       │
│  timer-store: active task + persisted session state  │
│  pop-out-store: small-window open/request state      │
└─────────────┬───────────────────────┬───────────────┘
              │                       │
              ▼                       ▲
┌─────────────────────────────────────────────────────┐
│               REACT UI                              │
│  Sidebar (task pool) ← Todoist tasks                │
│  Day Flow (canvas) ← flow assignments + timer       │
│  Timer display ← timer store                        │
│  Settings dialog ← settings API                     │
└─────────────────────────────────────────────────────┘
```

---

## 10. Build Sessions — Completed

### Session 1 — Scaffold ✅
- Next.js + Tailwind + shadcn/ui setup
- App shell layout (sidebar + main canvas + top bar)
- Dark mode with system/light/dark toggle
- Mock task data

### Session 2 — Task Pool ✅
- Collapsible sidebar with search
- Task cards grouped by Today, Overdue, by Project
- Draggable task cards (`@dnd-kit/react`)
- Drag overlay with tilted appearance

### Session 3 — Day Flow ✅
- Droppable day flow zone with sortable task cards
- "Next" badge on top task
- Complete, skip, remove actions
- Read-only multi-day view (3-day, 5-day)
- Progress bar (tasks done, time remaining)
- Date navigation + "Today" button

### Session 4 — Timer + SQLite Persistence ✅
- SQLite database with `time_entries` table
- Segment-based live timer (start/pause/resume)
- Timer display in top bar, sidebar, and flow cards
- Manual time entry CRUD (add/edit/delete via popover + dialogs)
- Dev-mode fresh DB via `predev` script

### Session 5 — Todoist Integration + Full Persistence ✅
- SQLite tables for tasks, settings, flow_tasks, completed_flow_tasks
- Todoist API client (read-only) with cursor-based pagination
- Fetches all active tasks, then the sidebar filters to today, overdue, and selected planning-date contexts
- Settings dialog for API key input
- Manual refresh button + 1-minute auto-sync
- Task and flow persistence across page refreshes
- Write-through from Zustand to SQLite on all flow mutations

### Session 6 — Editable Estimates, Descriptions, Sidebar Lists ✅
- Editable estimated duration: click-to-edit on sidebar task cards and flow task cards, persisted via `PATCH /api/tasks`
- Task description: synced from Todoist API, shown as hover tooltip on sidebar task cards
- Completed task rows in day flow now show both estimated time and actual logged time
- Sidebar "Arranged" list: shows tasks added to the current day's flow (primary accent)
- Sidebar "Completed" list: shows completed tasks with logged time and estimate
- Database migration: added `description` column to tasks table
- Bug fixes: fixed `better-sqlite3` transaction invocation (must call returned function), timezone-aware overdue comparison

### Session 7 — Soft-Delete & Task Retention ✅
- Todoist sync no longer deletes local tasks when they disappear from the API (date changed, completed, deleted in Todoist)
- Soft-delete: trash icon on sidebar task cards marks tasks with `deleted_at` timestamp (never hard-deleted)
- Soft-deleted tasks hidden from all active views (sidebar pool, flows)
- Todoist sync preserves soft-delete status — syncing never resurrects deleted tasks
- Calendar-based deleted tasks browser: trash icon in sidebar header opens a dialog with monthly calendar view, dot indicators on dates with deleted tasks, search across all deleted tasks, and one-click restore
- Deleting a task in a flow automatically removes it from the flow and stops any active timer
- Database migration: added `deleted_at` column to tasks table
- New API endpoints: `DELETE /api/tasks` (soft-delete), `GET /api/tasks/deleted` (list), `POST /api/tasks/deleted` (restore)

### Session 8 — Roll-over & Day Capacity ✅
- Roll-over logic exists in `PUT /api/flows` and the flow store for moving incomplete tasks between dates with deduping
- `PUT /api/flows` `rollover` action handles server-side logic
- Day capacity: configurable hours in Settings dialog (default 6h), stored as `day_capacity_mins`
- Progress bar shows capacity (`/ 6h cap`) and amber warning when overcommitted
- Capacity stored reactively in flow store `dayCapacityMins` — updates instantly on save without page refresh
- `PUT /api/settings` extended to accept `day_capacity_mins` alongside API key

### Session 9 — Daily Planning Ritual ✅
- "Start My Day" multi-step wizard: add tasks → review estimates → capacity check → confirm
- Auto-triggered when today's flow is empty and planning not completed; also available via "Plan My Day" button
- Three visible steps in the current UI: Add, Review, Ready
- Per-date `planning_completed:<date>` flag stored in SQLite settings table
- `PUT /api/flows` `rollover` and `rolloverSelected` actions remain available at the API/store layer for future UI use
- Flow store `hydrated` flag ensures wizard doesn't trigger before data loads
- New component: `planning-wizard.tsx`

### Session 10 — Task Notes & Session Log ✅ Implemented
- New `flow_task_notes` table (id, task_id, flow_date, content, updated_at) with UNIQUE(task_id, flow_date)
- Drizzle schema: `flowTaskNotes` export in `lib/db/schema.ts`
- CRUD queries: `getNote`, `getNotesByDate`, `upsertNote` (onConflictDoUpdate) in `lib/db/queries.ts`
- API route: `/api/notes` — GET (single note or by date) + PUT (upsert)
- `useTaskNote` hook in `flow-task-card.tsx`: fetch on mount, debounced 500ms auto-save, toggle visibility
- StickyNote icon toggle in flow card action buttons; auto-opens if note has content
- `CompletedTaskRow`: fetches note and shows read-only text (line-clamp-2) below row
- `ReadOnlyTaskRow` / `ReadOnlyCompletedRow`: fetch note, show truncated text + StickyNote icon indicator
- `onMouseDown stopPropagation` on textarea prevents dnd-kit drag interference

### Session 11 — Analytics & Weekly Review Dashboard ✅ Implemented
- BarChart3 icon in top bar opens analytics dialog
- **Date/week navigation**: prev/next arrows and click-to-today within daily and weekly views (local state, doesn't affect main app date)
- Daily Review tab: summary cards (tasks, logged, estimated, accuracy), capacity usage bar, **hourly activity bar chart** (hours 6–23), per-task estimated vs. actual horizontal bars, **estimation vs actual table** with diff column (green/red coloring)
- Weekly Review tab: summary cards (done, hours, avg/day, accuracy), daily trend bar chart (Mon–Sun), **work time heatmap** (7×17 grid: Mon–Sun × hours 6–22, intensity-colored cells), time by project with colored bars, stuck work detection (2+ days, not completed), estimation accuracy table with color-coded percentages
- Work Patterns tab: all-time heatmap (frequency/duration toggle), peak hours summary
- API route: `GET /api/analytics?type=daily|weekly|stats&date=YYYY-MM-DD`
- New query helpers: `getEntriesInDateRange`, `getFlowTaskIdsInDateRange`, `getCompletedTaskIdsInDateRange`, `getTasksByIds`, `getAllTimeEntries`
- Pure CSS/Tailwind charts — no external charting library

### Session 12 — Testing & Docker Deployment ✅ Implemented
- **Vitest** test runner with `@` path alias and serial execution (`fileParallelism: false`)
- Per-test DB isolation: `beforeEach` closes SQLite connection via `globalThis.__flowdaySqlite` and wipes DB files
- **Unit tests**: utility logic, database query helpers, timer behavior, Zustand stores, Todoist API pagination, sync transforms, and documentation sync guards
- **Integration tests**: route handlers for analytics, entries, export, flows, notes, settings, sync, tasks, deleted tasks, and timer persistence
- **Playwright UI tests**: seeded browser coverage for the wizard, flow/shell journeys, timers, settings, export, analytics, and multi-day read-only behavior
- **Docker**: multi-stage build (Node 24 Alpine) — deps → build → standalone runner, non-root `nextjs` user, `/app/db` directory with correct permissions
- **GitHub Actions CI/CD**: lint, typecheck, unit tests, integration tests, UI tests, screenshot goldens, build, then Docker build & push to GHCR on main push or release
- Docker metadata: tags by branch, semver, and SHA; GHA build cache for fast rebuilds
- `output: "standalone"` in next.config.ts for minimal Docker images
- `.dockerignore` excludes tests, docs, DB files, and `.git`

### Session 13 — Quick Add, Export, Editable Titles & PWA ✅ Implemented
- **Quick add:** Inline input in sidebar to create local tasks (`local-<uuid>` ID, today's due date, default priority). `POST /api/tasks` endpoint. `addLocalTask` action in todoist store.
- **Local completion visibility:** Local tasks completed in FlowDay on a prior date stay out of future Overdue pools; undoing that completion makes the local task eligible again.
- **Editable titles:** Local (non-Todoist) tasks show pencil icon on hover. Inline input with Enter/Escape/blur commit. `updateTitle` action + `PATCH /api/tasks` with `title` field. Works in both sidebar `TaskCard` and flow `FlowTaskCard` via `EditableTitle` / `EditableFlowTitle` components.
- **Data export:** Export dialog in settings — select data type (time entries / flow history), date range, format (CSV/JSON). `GET /api/export?type=entries|flows&format=csv|json&start=&end=`. Download via anchor element.
- **PWA support:** Web manifest (`app/pwa/manifest.webmanifest/route.ts`), app icons (SVG + PNG at 192/512/maskable), service worker source (`public/sw.js`) served through `app/pwa/sw/route.ts`, `apple-touch-icon`, and theme-color meta tags. Service worker uses network-first for navigation and API calls, stale-while-revalidate for static assets.
- **Service worker safety:** SW only registered in production. Development mode auto-unregisters stale service workers to prevent cached HTML from loading outdated JS bundles after dev server restarts.
- **Timezone fix:** All "today" comparisons use `date-fns format()` (local time) instead of `toISOString().slice(0,10)` (UTC). Settings API accepts `?today=` param from client so VPS timezone doesn't affect `planning_completed_today` check.
- **Integration tests:** 6 new test files (export, flows, notes, settings, tasks, deleted tasks) covering all API routes
- **Refactors:** `useEffect`-based dialog initialization replaced with `onOpenChange` callbacks (analytics, manual entry, deleted tasks, estimate editor) for simpler lifecycle management. Progress bar `getEntryRevision()` extracted from dependency array.

### Session 14 — UI Polish, Goldens, and Production Hygiene ✅ Implemented
- **Overall visual polish**: Refined app shell, sidebar, day-flow hierarchy, task-card treatments, planning wizard, analytics surfaces, and small pop-out timer while preserving existing workflows and selectors
- **Feature-boundary cleanup**: Moved major app surfaces under `features/*` while keeping shared reusable UI in `components/*` and source-of-truth database helpers in `lib/db/*`
- **README screenshots**: Maintained onboarding-first screenshots in `docs/readme` with deterministic generation and CI comparison
- **UI visual goldens**: Added broader product screenshots under `docs/ui-goldens` covering shell, planning, timer, pop-out, settings, analytics, dark mode, and multi-day states
- **CI screenshot checks**: Added README screenshot and UI-golden checks on Ubuntu 24.04 with fixed seed data, viewport, timezone, reduced motion, and small pixel-diff budgets for renderer drift
- **Production/test split**: Moved seed/reset helpers and the browser E2E bridge under `features/testing`, converted test API route files to `route.e2e.ts`, and gated them with `E2E_TEST_MODE=1`
- **Docker payload hygiene**: Added `npm run docker:prune` to remove or fail on test routes, test helpers, docs, markdown files, source maps, local DB files, and E2E marker strings in `.next/standalone`

---

## 11. Key Design Principles

1. **Sequential, not scheduled.** The day flow is an ordered list, not a calendar grid. This is the core differentiator.

2. **Todoist is the inbox, FlowDay is the workbench.** Don't rebuild task management. Let Todoist handle projects, priorities, recurring tasks. FlowDay just answers: "What am I doing today, and in what order?"

3. **Passive tracking.** The timer should be so frictionless that you forget it's running. Start on activate, stop on complete. That's it.

4. **Data compounds.** Every day you use FlowDay, your analytics get smarter. After a month, you'll know exactly how long "a code review" takes you.

5. **Read-only safety.** FlowDay never modifies Todoist data. This prevents bugs from corrupting the user's real task list.

6. **Local-first persistence.** SQLite is the source of truth. Zustand stores are reactive cache. Todoist is an upstream data source, not a dependency — the app works offline with cached data.

---

## 12. UI Layout

```
┌──────────────────────────────────────────────────────────────┐
│  FlowDay          [← Today, Apr 12 →]  [1][3][5]   ⏱  🌙 ⚙ │
├────────────────┬─────────────────────────────────────────────┤
│  Todoist       │                                             │
│  [🔄] [▢×]    │  Your day flow will appear here             │
│                │  Drag tasks from the sidebar to start       │
│  ┌──────────┐  │  planning your day                         │
│  │ 🔴 Task  │  │                                             │
│  │ Project   │  │  ─── or when tasks are added: ───          │
│  └──────────┘  │                                             │
│  ┌──────────┐  │  ┌─────────────────────────────────────┐   │
│  │ 🟡 Task  │──┼─▶│ NEXT  Design login page              │   │
│  │ Project   │  │  │ 30m est  5:23  ▶ 🕐 ✓ ⏬ ×         │   │
│  └──────────┘  │  └─────────────────────────────────────┘   │
│                │  ┌─────────────────────────────────────┐   │
│  🔍 Search...  │  │ Write API docs                        │   │
│                │  │ 45m est  —     ▶ 🕐 ✓ ⏬ ×           │   │
│  ♦ Active:     │  └─────────────────────────────────────┘   │
│  Task  5:23    │                                             │
│  ⏸             │  Completed (1)                              │
│                │  ┌─ ̶R̶e̶v̶i̶e̶w̶ ̶P̶R̶ ↩ ─────────────────────┐   │
│  ▼ Today (3)   │                                             │
│  ▼ Overdue (2) │  ━━━━━━━━━━━━━━ 1/3 · 5m · ~75m left ━━━  │
│  ▼ Work (5)    │                                             │
└────────────────┴─────────────────────────────────────────────┘
```

---

*Last updated: May 4, 2026*
*Version: 1.7 — Quick-task grouping and local completed-task overdue cleanup*
