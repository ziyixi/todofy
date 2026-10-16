import { createRoot, type Root } from "react-dom/client";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ChevronDown, ChevronRight, LayoutList, Target } from "lucide-react";
import { App } from "./App";
import { detailTask, find, findAll, keepsVisible, matchesId } from "./anchors";
import { planConfig, todoistTaskUrl } from "./domain";
import { NativeTaskTools } from "./NativeTaskTools";
import { PlusBoundary } from "./PlusBoundary";
import {
  cachedPlanConfig,
  extensionActions,
  openOptions,
  readOtherViews,
  reportPage,
  saveOtherViews,
} from "./client";
import type { Enhancement, PageStatus, Reason } from "./page-status";
import { words } from "./i18n";
import type {
  Language,
  PlanConfig,
  PlanMetadata,
  PlusSnapshot,
  View,
} from "./model";

const viewParam = "todoist-plus";
// A flickering anchor must not turn into endless re-mounts.
const MOUNTS_PER_MINUTE = 10;
// One pass per frame at most. Only passes in which Plus changed the page count: a feedback loop
// needs a change in every pass, while Todoist's own scrolling and drags change nothing of
// Plus's. Sustained beyond this, native Todoist wins.
const PASS_LIMIT = 1500;
const PASS_WINDOW_MS = 30_000;
// A page still missing an anchor after this long is reported in the options page.
const STARTUP_GRACE_MS = 15_000;

export function languageOf(document: Document): Language {
  return document.documentElement.lang.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}
/**
 * Colours need no copying: Todoist's theme tokens inherit into the shadow roots, and styles.css
 * reads them. Only the native nav row's geometry is measured.
 */
function applyNavigationLayout(host: HTMLElement, reference: HTMLElement) {
  const computed = getComputedStyle(reference);
  const width = reference.getBoundingClientRect().width;
  if (width) host.style.setProperty("--plus-nav-width", `${width}px`);
  host.style.fontSize = computed.fontSize;
  host.style.lineHeight = computed.lineHeight;
  host.style.fontWeight = computed.fontWeight;
}

/** Allows `limit` calls per fixed window of `windowMs`. */
function limiter(limit: number, windowMs: number) {
  let start = -Infinity;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - start >= windowMs) {
      start = now;
      count = 0;
    }
    return ++count <= limit;
  };
}

type Ui = ShadowRootContentScriptUi<unknown>;

/**
 * Native Todoist stays hidden only while its replacement is attached: every failure path (a
 * re-created container, a rejected mount, a render error, a disabled extension) shows it again.
 */
export async function mountTodoist(ctx: ContentScriptContext) {
  const hidden = new Map<
    HTMLElement,
    { hidden: string | null; display: string; priority: string }
  >();
  const nativeCurrent = new Set<HTMLElement>();
  const cleanups: (() => void)[] = [];
  let content: HTMLElement | undefined;
  let mainUi: Ui | undefined;
  let mainHost: HTMLElement | undefined;
  let mainRoot: Root | undefined;
  let mainResize: ResizeObserver | undefined;
  let navUi: Ui | undefined;
  let navHost: HTMLElement | undefined;
  let config: PlanConfig | undefined;
  // The last confirmed data stays in this page's memory only, so returning to Plus paints at once.
  let snapshot: PlusSnapshot | undefined;
  const keepSnapshot = (next?: PlusSnapshot) => {
    snapshot = next;
  };
  // Started before the sidebar exists, so mounting rarely waits for them.
  const savedConfig = cachedPlanConfig().catch(() => undefined);
  const savedOtherViews = readOtherViews().catch(() => false);
  let view: View | undefined;
  let language = languageOf(document);
  let disposed = false;
  let mounting = false;
  let started = false;
  const mayMount = limiter(MOUNTS_PER_MINUTE, 60_000);
  let navUpdate: (() => void) | undefined;
  let detailId = "";
  let detailHost: HTMLElement | undefined;
  let detailCleanup: (() => void) | undefined;
  let detailPending = false;
  // A pass that found a mount in flight; the mount re-checks the current modal when it settles.
  let detailAgain = false;
  let detailsReady = false;
  // The task whose tools failed to render stays native until its modal closes.
  let detailFailed = "";
  // The owner's last open or closed choice, kept in storage.local; read once, at the first mount.
  let otherViewsOpen: boolean | undefined;
  let favoritesRoot: Root | undefined;
  let favoritesHost: HTMLElement | undefined;
  let favoritesCleanup: (() => void) | undefined;
  let favoritesPending = false;
  let favoritesKey = "";
  // Plus's own changes to Todoist's DOM (hiding, restoring, rendering, host display), so the
  // loop breaker counts only passes that changed something.
  let writes = 0;
  // While the Plus view shows its crash line, no re-mount clears that from the page check.
  let renderFailed = false;
  // A hidden tab runs no frames; its startup check waits until the tab is shown.
  let startupWaiting = false;
  // What is off and why, from closed key sets; sent only when it changes.
  const off: PageStatus["off"] = {};
  let reported = "";
  function note(enhancement: Enhancement, reason?: Reason) {
    if (reason) off[enhancement] = reason;
    else delete off[enhancement];
    const status: PageStatus = {
      language: languageOf(document),
      off: { ...off },
    };
    const key = JSON.stringify(status);
    if (key === reported) return;
    reported = key;
    reportPage(status);
  }

  const selectionStyle = document.createElement("style");
  selectionStyle.textContent = `
    [data-todoist-plus-native-current],
    [data-todoist-plus-native-current] > a {
      background-color: transparent !important;
      color: var(--product-library-display-primary-idle-tint, inherit) !important;
    }
    [data-todoist-plus-native-current] svg {
      color: var(--product-library-display-primary-idle-tint, inherit) !important;
    }
  `;
  document.head.append(selectionStyle);
  cleanups.push(() => selectionStyle.remove());

  function syncNativeSelection() {
    const sidebar = find("sidebar");
    const selected = new Set(
      view && config?.configured && sidebar
        ? findAll("current", sidebar).map(
            (element) => element.closest("li") ?? element,
          )
        : [],
    );
    for (const element of nativeCurrent) {
      if (!selected.has(element)) {
        element.removeAttribute("data-todoist-plus-native-current");
        nativeCurrent.delete(element);
      }
    }
    for (const element of selected) {
      element.setAttribute("data-todoist-plus-native-current", "");
      nativeCurrent.add(element);
    }
  }

  function hide(element: HTMLElement) {
    if (hidden.has(element)) return;
    writes++;
    hidden.set(element, {
      hidden: element.getAttribute("hidden"),
      display: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
    });
    element.hidden = true;
    element.style.setProperty("display", "none", "important");
  }
  function restore() {
    if (hidden.size) writes++;
    for (const [element, before] of hidden) {
      if (before.hidden === null) element.removeAttribute("hidden");
      else element.setAttribute("hidden", before.hidden);
      if (before.display)
        element.style.setProperty("display", before.display, before.priority);
      else element.style.removeProperty("display");
    }
    hidden.clear();
  }
  function viewValue() {
    return new URL(location.href).searchParams.get(viewParam);
  }
  function currentView(): View | undefined {
    const value = viewValue();
    // The weekly review task links to `review`: Plan with its checklist open.
    if (value === "review") return "plan";
    return value === "plan" || value === "focus" ? value : undefined;
  }
  function favoriteRows() {
    const sidebar = find("sidebar");
    const list = sidebar && find("favorite", sidebar)?.closest("ul");
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((link) => {
        const match = new URL(link.href).pathname.match(
          /\/app\/(filter|label)\/([^/]+)$/u,
        );
        let row = link.closest<HTMLElement>("li") ?? link;
        while (
          row.parentElement &&
          row.parentElement !== list &&
          row.parentElement.children.length === 1
        )
          row = row.parentElement;
        return match
          ? { row, link, kind: match[1], slug: match[2]! }
          : undefined;
      })
      .filter((row) => row !== undefined);
  }
  async function showOtherViews(rows: HTMLElement[]) {
    if (!favoritesHost?.isConnected && !favoritesPending && rows.length) {
      favoritesCleanup?.();
      favoritesPending = true;
      const anchor = rows[0]!;
      let ui: Ui;
      try {
        ui = await createShadowRootUi(ctx, {
          inheritStyles: true,
          name: "todoist-plus-other-views",
          position: "inline",
          anchor,
          append: "before",
          onMount(container) {
            const root = createRoot(container);
            favoritesRoot = root;
            return root;
          },
          onRemove(root) {
            root?.unmount();
          },
        });
      } finally {
        favoritesPending = false;
      }
      if (disposed || !anchor.isConnected) return;
      ui.mount();
      favoritesHost = ui.shadowHost;
      favoritesKey = "";
      const sidebar = find("sidebar");
      const reference = sidebar && find("upcoming", sidebar);
      if (reference) applyNavigationLayout(favoritesHost, reference);
      favoritesCleanup = () => {
        ui.remove();
        favoritesRoot = undefined;
        favoritesHost = undefined;
      };
      // Extra favourites fold away only once their toggle is in place, and only from what the
      // page and the settings are now: the rows and the config may have changed while it loaded.
      hideReplaced();
      return;
    }
    if (!favoritesRoot || !favoritesHost) return;
    const visible = Boolean(config?.configured && rows.length);
    const display = visible ? "block" : "none";
    if (favoritesHost.style.display !== display) {
      writes++;
      favoritesHost.style.display = display;
    }
    const key = `${visible}:${otherViewsOpen}:${rows.length}:${languageOf(document)}`;
    if (key === favoritesKey) return;
    favoritesKey = key;
    favoritesRoot.render(
      <div className="plus-extension-nav plus-other-views">
        <button
          aria-expanded={Boolean(otherViewsOpen)}
          onClick={() => {
            otherViewsOpen = !otherViewsOpen;
            saveOtherViews(otherViewsOpen);
            restore();
            hideReplaced();
          }}
        >
          {otherViewsOpen ? (
            <ChevronDown size={24} />
          ) : (
            <ChevronRight size={24} />
          )}
          {languageOf(document) === "zh" ? "其他视图" : "Other views"}
          <span className="plus-other-count">{rows.length}</span>
        </button>
      </div>,
    );
  }
  function hideReplaced() {
    syncNativeSelection();
    if (!mainHost?.isConnected) {
      // Nothing native stays hidden while the Plus view is not attached.
      restore();
      void showOtherViews([]);
      return;
    }
    if (view && content) {
      for (const child of Array.from(content.children))
        if (
          child instanceof HTMLElement &&
          child !== mainHost &&
          !keepsVisible(child)
        )
          hide(child);
    }
    if (!config?.configured) {
      void showOtherViews([]);
      return;
    }
    const labelIds = config.labelIds;
    const extras: HTMLElement[] = [];
    for (const { row, link, kind, slug } of favoriteRows()) {
      if (
        (kind === "filter" && matchesId(slug, config.hiddenFilterIds)) ||
        (kind === "label" && matchesId(slug, labelIds)) ||
        /^[-_]{3,}$/u.test(link.textContent?.trim() ?? "")
      ) {
        hide(row);
      } else {
        extras.push(row);
        if (!otherViewsOpen && favoritesHost?.isConnected) hide(row);
      }
    }
    void showOtherViews(extras);
    if (!detailsReady || !detailHost?.isConnected) return;
    const modal = find("detail");
    for (const link of modal
      ? findAll<HTMLAnchorElement>("detailLabel", modal)
      : []) {
      const slug = new URL(link.href).pathname.match(
        /\/app\/label\/([^/]+)$/u,
      )?.[1];
      if (slug && matchesId(slug, labelIds)) hide(link);
    }
  }
  const ready = (next?: PlanConfig) => {
    config = next;
    if (!next?.configured) detailsReady = false;
    restore();
    hideReplaced();
  };
  const planReady = (next?: PlanMetadata) => ready(next && planConfig(next));
  const unavailable = () => ready();
  const detailReady = (next?: PlanMetadata) => {
    detailsReady = Boolean(next?.configured);
    if (next) config = planConfig(next);
    restore();
    hideReplaced();
  };
  function render() {
    if (!content || !mainRoot || !mainHost) return;
    writes++;
    restore();
    const nextView = currentView();
    if (view && !nextView) mainRoot.render(null);
    view = nextView;
    language = languageOf(document);
    mainHost.style.display = view ? "block" : "none";
    if (view) {
      mainRoot.render(
        <PlusBoundary
          language={language}
          className="plus-root"
          resetKey={view}
          onError={() => {
            renderFailed = true;
            note("views", "renderError");
          }}
          onRendered={() => {
            renderFailed = false;
            if (off.views === "renderError") note("views");
          }}
          onBack={leavePlus}
        >
          <App
            actions={extensionActions}
            view={view}
            language={language}
            onOpenTask={(id) => location.assign(todoistTaskUrl(id))}
            onSettings={openOptions}
            onReady={planReady}
            onViewChange={navigate}
            snapshot={snapshot}
            onSnapshot={keepSnapshot}
            review={viewValue() === "review"}
          />
        </PlusBoundary>,
      );
    }
    hideReplaced();
    navUpdate?.();
  }
  function navigate(next: View) {
    const url = new URL(location.href);
    url.searchParams.set(viewParam, next);
    history.pushState(null, "", url);
    // A view the re-mount cap left out comes back on this click once the cap allows it.
    if (!mainHost) void mount();
    render();
  }
  /** Back to the native page the Plus view replaced. */
  function leavePlus() {
    const url = new URL(location.href);
    url.searchParams.delete(viewParam);
    history.pushState(null, "", url);
    render();
  }
  async function mountMain(anchor: HTMLElement) {
    const ui = await createShadowRootUi(ctx, {
      inheritStyles: true,
      name: "todoist-plus-view",
      position: "inline",
      anchor,
      append: "last",
      isolateEvents: ["keydown", "keyup", "keypress"],
      onMount(container) {
        const root = createRoot(container);
        mainRoot = root;
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    if (disposed || !anchor.isConnected) return;
    ui.mount();
    mainUi = ui;
    mainHost = ui.shadowHost;
    content = anchor;
    // The fixed timer bar centres on this column wherever the sidebar is, collapsed or resized.
    const host = ui.shadowHost;
    mainResize = new ResizeObserver(() => {
      const box = host.getBoundingClientRect();
      if (!box.width) return;
      host.style.setProperty(
        "--plus-content-center",
        `${box.left + box.width / 2}px`,
      );
      host.style.setProperty("--plus-content-width", `${box.width}px`);
    });
    mainResize.observe(host);
  }
  /** Todoist re-created the container: Plus leaves with it and native Todoist shows again. */
  function dropMain() {
    mainResize?.disconnect();
    mainResize = undefined;
    mainUi?.remove();
    mainUi = undefined;
    mainHost = undefined;
    mainRoot = undefined;
    content = undefined;
    view = undefined;
    hideReplaced();
  }
  async function mountNav(sidebar: HTMLElement) {
    const upcoming = find("upcoming", sidebar);
    const anchor = find("topMenu") ?? upcoming?.closest("li") ?? sidebar;
    const ui = await createShadowRootUi(ctx, {
      inheritStyles: true,
      name: "todoist-plus-navigation",
      position: "inline",
      anchor,
      append: anchor === sidebar ? "first" : "after",
      onMount(container) {
        const root = createRoot(container);
        let previous = "";
        navUpdate = () => {
          const key = `${currentView()}:${languageOf(document)}`;
          if (key === previous) return;
          previous = key;
          const text = words(languageOf(document));
          root.render(
            <nav className="plus-extension-nav" aria-label="Todoist Plus">
              {(["plan", "focus"] as const).map((item) => (
                <button
                  key={item}
                  aria-current={currentView() === item ? "page" : undefined}
                  onClick={() => navigate(item)}
                >
                  <span className="plus-nav-icon" aria-hidden="true">
                    {item === "plan" ? (
                      <LayoutList size={18} />
                    ) : (
                      <Target size={18} />
                    )}
                  </span>
                  {text[item]}
                </button>
              ))}
            </nav>,
          );
        };
        navUpdate();
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    if (disposed || !anchor.isConnected) return;
    ui.mount();
    navUi = ui;
    navHost = ui.shadowHost;
    if (upcoming) applyNavigationLayout(navHost, upcoming);
  }
  function dropNav() {
    navUi?.remove();
    navUi = undefined;
    navHost = undefined;
    navUpdate = undefined;
  }
  async function mount() {
    if (mounting || disposed) return;
    const sidebar = find("sidebar");
    const nextContent = content ?? find("content");
    // The first mount waits for both; later each host comes back with its own anchor.
    if (!started && (!sidebar || !nextContent)) return;
    const main = mainHost ? undefined : nextContent;
    const nav = navHost ? undefined : sidebar;
    if (!main && !nav) return;
    if (!mayMount()) return note("views", "remountLimited");
    mounting = true;
    try {
      if (main) await mountMain(main);
      if (nav) await mountNav(nav);
      config ??= await savedConfig;
      otherViewsOpen ??= await savedOtherViews;
    } finally {
      mounting = false;
    }
    if (disposed) return;
    render();
    if (mainHost && navHost && !renderFailed) note("views");
    if (started || !mainHost) return;
    started = true;
    if (!view) {
      // Only the account settings are needed to arrange the sidebar, never the task list.
      void extensionActions
        .readPlan()
        .then((next) => {
          if (!disposed) ready(planConfig(next));
        })
        .catch(() => {
          if (!disposed) ready();
        });
    }
  }
  function removeDetails() {
    if (detailHost) {
      detailCleanup?.();
      detailHost = undefined;
      detailsReady = false;
      restore();
      hideReplaced();
    }
    detailId = "";
  }
  async function mountDetails() {
    const modal = find("detail");
    if (!modal) detailFailed = "";
    const task = modal ? detailTask(modal, location.href) : {};
    const anchor = modal && find("detailMain", modal);
    if (modal && (task.off || !anchor))
      note("taskTools", task.off ?? "detailMain");
    const id = task.id;
    if (!id || !anchor || id === detailFailed) return removeDetails();
    if (detailPending) {
      detailAgain = true;
      return;
    }
    if (detailId === id && detailHost?.isConnected) return;
    detailCleanup?.();
    detailPending = true;
    detailsReady = false;
    detailId = id;
    let ui: Ui;
    try {
      ui = await createShadowRootUi(ctx, {
        inheritStyles: true,
        name: "todoist-plus-task-tools",
        position: "inline",
        anchor,
        append: "last",
        isolateEvents: ["keydown", "keyup", "keypress"],
        onMount(container) {
          const root = createRoot(container);
          root.render(
            <PlusBoundary
              language={languageOf(document)}
              className="plus-native-tools plus-root"
              onError={() => note("taskTools", "renderError")}
              onBack={() => {
                detailFailed = id;
                removeDetails();
              }}
            >
              <NativeTaskTools
                taskId={id}
                language={languageOf(document)}
                onReady={detailReady}
                onUnavailable={unavailable}
                snapshot={snapshot}
                onSnapshot={keepSnapshot}
              />
            </PlusBoundary>,
          );
          return root;
        },
        onRemove(root) {
          root?.unmount();
        },
      });
    } finally {
      detailPending = false;
    }
    if (disposed) return;
    if (detailAgain || !anchor.isConnected) {
      // Todoist replaced the modal while the UI was being created: check the modal now on the page.
      detailAgain = false;
      detailId = "";
      return mountDetails();
    }
    ui.mount();
    note("taskTools");
    detailHost = ui.shadowHost;
    detailCleanup = () => {
      ui.remove();
    };
  }
  function teardown() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    detailCleanup?.();
    favoritesCleanup?.();
    dropMain();
    dropNav();
    for (const cleanup of cleanups) cleanup();
    restore();
    for (const element of nativeCurrent)
      element.removeAttribute("data-todoist-plus-native-current");
  }
  const passAllowed = limiter(PASS_LIMIT, PASS_WINDOW_MS);
  function pass() {
    if (disposed || ctx.isInvalid) return;
    const before = writes;
    if (mainHost && !mainHost.isConnected) dropMain();
    if (navHost && !navHost.isConnected) dropNav();
    navUpdate?.();
    if (!mainHost || !navHost) void mount();
    if (
      mainHost &&
      (currentView() !== view || languageOf(document) !== language)
    )
      render();
    else hideReplaced();
    void mountDetails();
    // Todoist changing its own page (scrolling a long list, say) never counts.
    if (writes !== before && !passAllowed()) {
      note("views", "passLimited");
      teardown();
    }
  }
  let frame = 0;
  const observer = new MutationObserver(() => {
    // Reading it fires onInvalidated once the extension is disabled, reloaded or updated.
    if (ctx.isInvalid || frame) return;
    // The window's own request: WXT's wrapper keeps a listener per frame until the page unloads.
    frame = requestAnimationFrame(() => {
      frame = 0;
      pass();
    });
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "lang"],
  });
  ctx.addEventListener(window, "popstate", render);
  ctx.addEventListener(window, "wxt:locationchange", render);
  // Coming back to the tab after disabling or reloading the extension restores Todoist at once.
  const checkValid = () => ctx.isInvalid;
  ctx.addEventListener(document, "visibilitychange", checkValid);
  ctx.addEventListener(window, "focus", checkValid);
  ctx.onInvalidated(teardown);
  /** Names the anchor still missing once the page had time to render, if Plus has not started. */
  function startupCheck() {
    if (started || disposed) return;
    // A hidden tab runs no frames, so no pass has looked yet; its grace starts when it is shown.
    if (document.visibilityState === "hidden") {
      startupWaiting = true;
      return;
    }
    if (!find("sidebar")) note("views", "sidebar");
    else if (!find("content")) note("views", "content");
  }
  ctx.addEventListener(document, "visibilitychange", () => {
    if (!startupWaiting || document.visibilityState === "hidden") return;
    startupWaiting = false;
    ctx.setTimeout(startupCheck, STARTUP_GRACE_MS);
  });
  ctx.setTimeout(startupCheck, STARTUP_GRACE_MS);
  await mount();
}
