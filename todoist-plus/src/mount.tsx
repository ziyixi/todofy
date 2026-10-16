import { createRoot, type Root } from "react-dom/client";
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ChevronDown, ChevronRight, LayoutList, Target } from "lucide-react";
import { App } from "./App";
import { detailTaskId, keepsVisible, matchesId } from "./anchors";
import { planConfig, todoistTaskUrl } from "./domain";
import { NativeTaskTools } from "./NativeTaskTools";
import { PlusBoundary } from "./PlusBoundary";
import { cachedPlanConfig, extensionActions, openOptions } from "./client";
import { words } from "./i18n";
import type {
  Language,
  PlanConfig,
  PlanMetadata,
  PlusSnapshot,
  View,
} from "./model";

const viewParam = "todoist-plus";
const sidebarSelector =
  "[data-testid=app-sidebar-scrollable-container], #left_menu";
// A flickering anchor must not turn into endless re-mounts.
const MOUNTS_PER_MINUTE = 10;
// One pass per frame at most; a style feedback loop runs one every frame without end, while
// scrolling and drags come in bursts. Sustained beyond this, native Todoist wins.
const PASS_LIMIT = 1500;
const PASS_WINDOW_MS = 30_000;

export function languageOf(document: Document): Language {
  return document.documentElement.lang.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}
function applyTheme(host: HTMLElement, source: HTMLElement) {
  const computed = getComputedStyle(source);
  const rgb = computed.color.match(/\d+/gu)?.map(Number);
  const theme =
    rgb && rgb.length >= 3 && (rgb[0]! + rgb[1]! + rgb[2]!) / 3 > 160
      ? "dark"
      : "light";
  if (host.dataset.theme !== theme) host.dataset.theme = theme;
  const variables = {
    "--plus-bg":
      computed.backgroundColor === "rgba(0, 0, 0, 0)"
        ? getComputedStyle(document.body).backgroundColor
        : computed.backgroundColor,
    "--plus-text": computed.color,
  };
  const nativeAccent = computed
    .getPropertyValue("--product-library-actionable-primary-idle-tint")
    .trim();
  const nativeSelected = computed
    .getPropertyValue("--product-library-actionable-primary-selected-fill")
    .trim();
  if (nativeAccent) Object.assign(variables, { "--plus-accent": nativeAccent });
  if (nativeSelected)
    Object.assign(variables, { "--plus-selected": nativeSelected });
  for (const [name, value] of Object.entries(variables))
    if (host.style.getPropertyValue(name) !== value)
      host.style.setProperty(name, value);
  if (host.style.fontFamily !== computed.fontFamily)
    host.style.fontFamily = computed.fontFamily;
}

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
  const themeHosts = new Map<HTMLElement, HTMLElement>();
  const nativeCurrent = new Set<HTMLElement>();
  const cleanups: (() => void)[] = [];
  let content: HTMLElement | undefined;
  let mainUi: Ui | undefined;
  let mainHost: HTMLElement | undefined;
  let mainRoot: Root | undefined;
  let navUi: Ui | undefined;
  let navHost: HTMLElement | undefined;
  let config: PlanConfig | undefined;
  // The last confirmed data stays in this page's memory only, so returning to Plus paints at once.
  let snapshot: PlusSnapshot | undefined;
  const keepSnapshot = (next?: PlusSnapshot) => {
    snapshot = next;
  };
  // Started before the sidebar exists, so mounting rarely waits for it.
  const savedConfig = cachedPlanConfig().catch(() => undefined);
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
  let detailsReady = false;
  // The task whose tools failed to render stays native until its modal closes.
  let detailFailed = "";
  let otherViewsOpen = false;
  let favoritesRoot: Root | undefined;
  let favoritesHost: HTMLElement | undefined;
  let favoritesCleanup: (() => void) | undefined;
  let favoritesPending = false;
  let favoritesKey = "";

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
    const selected = new Set(
      view && config?.configured
        ? (document
            .querySelector(sidebarSelector)
            ?.querySelectorAll<HTMLElement>("li.current") ?? [])
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
    hidden.set(element, {
      hidden: element.getAttribute("hidden"),
      display: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
    });
    element.hidden = true;
    element.style.setProperty("display", "none", "important");
  }
  function restore() {
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
    const first = document
      .querySelector(sidebarSelector)
      ?.querySelector<HTMLAnchorElement>(
        "a[href*='/app/filter/'], a[href*='/app/label/']",
      );
    const list = first?.closest("ul");
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
      // Extra favourites fold away only once their toggle is in place.
      if (!otherViewsOpen) for (const row of rows) hide(row);
      const reference = document.querySelector<HTMLElement>(
        "#top-menu a[href$='/upcoming']",
      );
      if (reference) {
        themeHosts.set(favoritesHost, reference);
        applyTheme(favoritesHost, reference);
        applyNavigationLayout(favoritesHost, reference);
      }
      favoritesCleanup = () => {
        themeHosts.delete(ui.shadowHost);
        ui.remove();
        favoritesRoot = undefined;
        favoritesHost = undefined;
      };
    }
    if (!favoritesRoot || !favoritesHost) return;
    const visible = Boolean(config?.configured && rows.length);
    const display = visible ? "block" : "none";
    if (favoritesHost.style.display !== display)
      favoritesHost.style.display = display;
    const key = `${visible}:${otherViewsOpen}:${rows.length}:${languageOf(document)}`;
    if (key === favoritesKey) return;
    favoritesKey = key;
    favoritesRoot.render(
      <div className="plus-extension-nav plus-other-views">
        <button
          aria-expanded={otherViewsOpen}
          onClick={() => {
            otherViewsOpen = !otherViewsOpen;
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
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "[data-testid=task-details-modal] a[href*='/app/label/']",
    )) {
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
    restore();
    const nextView = currentView();
    if (view && !nextView) mainRoot.render(null);
    view = nextView;
    language = languageOf(document);
    mainHost.style.display = view ? "block" : "none";
    if (view) {
      applyTheme(mainHost, content);
      mainRoot.render(
        <PlusBoundary
          language={language}
          className="plus-root"
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
        mainRoot = createRoot(container);
      },
      onRemove() {
        mainRoot?.unmount();
      },
    });
    if (disposed || !anchor.isConnected) return;
    ui.mount();
    mainUi = ui;
    mainHost = ui.shadowHost;
    content = anchor;
    themeHosts.set(mainHost, anchor);
  }
  /** Todoist re-created the container: Plus leaves with it and native Todoist shows again. */
  function dropMain() {
    if (mainUi) themeHosts.delete(mainUi.shadowHost);
    mainUi?.remove();
    mainUi = undefined;
    mainHost = undefined;
    mainRoot = undefined;
    content = undefined;
    view = undefined;
    hideReplaced();
  }
  async function mountNav(sidebar: HTMLElement) {
    const upcoming = sidebar.querySelector<HTMLAnchorElement>(
      'a[href$="/upcoming"]',
    );
    const anchor =
      document.querySelector<HTMLElement>("#top-menu") ??
      upcoming?.closest("li") ??
      sidebar;
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
    const navReference = upcoming ?? sidebar;
    themeHosts.set(navHost, navReference);
    applyTheme(navHost, navReference);
    if (upcoming) applyNavigationLayout(navHost, upcoming);
  }
  function dropNav() {
    if (navUi) themeHosts.delete(navUi.shadowHost);
    navUi?.remove();
    navUi = undefined;
    navHost = undefined;
    navUpdate = undefined;
  }
  async function mount() {
    if (mounting || disposed) return;
    const sidebar =
      document.querySelector<HTMLElement>(sidebarSelector) ?? undefined;
    const nextContent =
      content ??
      document.querySelector<HTMLElement>("#content") ??
      document.querySelector<HTMLElement>("main") ??
      undefined;
    // The first mount waits for both; later each host comes back with its own anchor.
    if (!started && (!sidebar || !nextContent)) return;
    const main = mainHost ? undefined : nextContent;
    const nav = navHost ? undefined : sidebar;
    if ((!main && !nav) || !mayMount()) return;
    mounting = true;
    try {
      if (main) await mountMain(main);
      if (nav) await mountNav(nav);
      config ??= await savedConfig;
    } finally {
      mounting = false;
    }
    if (disposed) return;
    render();
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
    const modal = document.querySelector<HTMLElement>(
      "[data-testid=task-details-modal]",
    );
    if (!modal) detailFailed = "";
    const id = modal ? detailTaskId(modal, location.href) : undefined;
    const anchor = modal?.querySelector<HTMLElement>(
      "[data-testid=task-main-content-container]",
    );
    if (!id || !anchor || id === detailFailed) return removeDetails();
    if (detailPending || (detailId === id && detailHost?.isConnected)) return;
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
    if (disposed || !anchor.isConnected) return;
    ui.mount();
    detailHost = ui.shadowHost;
    themeHosts.set(detailHost, anchor);
    applyTheme(detailHost, anchor);
    detailCleanup = () => {
      themeHosts.delete(ui.shadowHost);
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
    if (!passAllowed()) return teardown();
    if (mainHost && !mainHost.isConnected) dropMain();
    if (navHost && !navHost.isConnected) dropNav();
    navUpdate?.();
    for (const [host, source] of themeHosts) applyTheme(host, source);
    if (!mainHost || !navHost) void mount();
    if (
      mainHost &&
      (currentView() !== view || languageOf(document) !== language)
    )
      render();
    else hideReplaced();
    void mountDetails();
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
    attributeFilter: ["class", "style", "lang", "data-theme"],
  });
  ctx.addEventListener(window, "popstate", render);
  ctx.addEventListener(window, "wxt:locationchange", render);
  // Coming back to the tab after disabling or reloading the extension restores Todoist at once.
  const checkValid = () => ctx.isInvalid;
  ctx.addEventListener(document, "visibilitychange", checkValid);
  ctx.addEventListener(window, "focus", checkValid);
  ctx.onInvalidated(teardown);
  await mount();
}
