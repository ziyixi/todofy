import { createRoot, type Root } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { ChevronDown, ChevronRight, LayoutList, Target } from "lucide-react";
import { App } from "./App";
import { planConfig, todoistTaskUrl } from "./domain";
import { NativeTaskTools } from "./NativeTaskTools";
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
export function taskIdFromElement(element: Element): string | undefined {
  const item = element.closest("[data-item-id], [data-selection-id]");
  const id =
    item?.getAttribute("data-item-id") ??
    item?.getAttribute("data-selection-id") ??
    "";
  return id && !id.startsWith("tmp-") ? id : undefined;
}
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

export async function mountTodoist(ctx: ContentScriptContext) {
  const hidden = new Map<
    HTMLElement,
    { hidden: string | null; display: string; priority: string }
  >();
  const themeHosts = new Map<HTMLElement, HTMLElement>();
  const nativeCurrent = new Set<HTMLElement>();
  const cleanups: (() => void)[] = [];
  let content: HTMLElement | undefined;
  let mainHost: HTMLElement | undefined;
  let mainRoot: Root | undefined;
  let config: PlanConfig | undefined;
  // The last confirmed data stays in this page's memory only, so returning to Plus paints at once.
  let snapshot: PlusSnapshot | undefined;
  const keepSnapshot = (next: PlusSnapshot) => {
    snapshot = next;
  };
  // Started before the sidebar exists, so mounting rarely waits for it.
  const savedConfig = cachedPlanConfig().catch(() => undefined);
  let view: View | undefined;
  let language = languageOf(document);
  let disposed = false;
  let mounting = false;
  let navUpdate: (() => void) | undefined;
  let detailId = "";
  let detailHost: HTMLElement | undefined;
  let detailCleanup: (() => void) | undefined;
  let detailPending = false;
  let detailsReady = false;
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
  function currentView(): View | undefined {
    const value = new URL(location.href).searchParams.get(viewParam);
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
  function matchesId(slug: string, ids: string[]) {
    return ids.some((id) => slug === id || slug.endsWith(`-${id}`));
  }
  async function showOtherViews(rows: HTMLElement[]) {
    if (!favoritesHost?.isConnected && !favoritesPending && rows.length) {
      favoritesCleanup?.();
      favoritesPending = true;
      const anchor = rows[0]!;
      const ui = await createShadowRootUi(ctx, {
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
      favoritesPending = false;
      if (disposed || !anchor.isConnected) return;
      ui.mount();
      favoritesHost = ui.shadowHost;
      favoritesKey = "";
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
    if (view && content && mainHost) {
      for (const child of Array.from(content.children))
        if (child instanceof HTMLElement && child !== mainHost) hide(child);
    }
    if (!config?.configured || !mainHost?.isConnected) {
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
        if (!otherViewsOpen) hide(row);
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
        <App
          actions={extensionActions}
          view={view}
          language={languageOf(document)}
          onOpenTask={(id) => location.assign(todoistTaskUrl(id))}
          onSettings={openOptions}
          onReady={planReady}
          onViewChange={navigate}
          snapshot={snapshot}
          onSnapshot={keepSnapshot}
        />,
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
  async function mount() {
    if (mainHost || mounting || disposed) return;
    const sidebar = document.querySelector<HTMLElement>(sidebarSelector);
    content =
      document.querySelector<HTMLElement>("#content") ??
      document.querySelector<HTMLElement>("main") ??
      undefined;
    if (!sidebar || !content) return;
    mounting = true;
    const mainUi = await createShadowRootUi(ctx, {
      inheritStyles: true,
      name: "todoist-plus-view",
      position: "inline",
      anchor: content,
      append: "last",
      isolateEvents: ["keydown", "keyup", "keypress"],
      onMount(container) {
        mainRoot = createRoot(container);
      },
      onRemove() {
        mainRoot?.unmount();
      },
    });
    mainUi.mount();
    mainHost = mainUi.shadowHost;
    themeHosts.set(mainHost, content);
    cleanups.push(() => mainUi.remove());
    const upcoming = sidebar.querySelector<HTMLAnchorElement>(
      'a[href$="/upcoming"]',
    );
    const anchor =
      document.querySelector<HTMLElement>("#top-menu") ??
      upcoming?.closest("li") ??
      sidebar;
    const navUi = await createShadowRootUi(ctx, {
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
    navUi.mount();
    const navReference = upcoming ?? sidebar;
    themeHosts.set(navUi.shadowHost, navReference);
    applyTheme(navUi.shadowHost, navReference);
    if (upcoming) applyNavigationLayout(navUi.shadowHost, upcoming);
    cleanups.push(() => navUi.remove());
    config ??= await savedConfig;
    mounting = false;
    render();
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
  async function mountDetails() {
    const modal = document.querySelector<HTMLElement>(
      "[data-testid=task-details-modal]",
    );
    // The first selected row is the edited task; later IDs belong to its children.
    const selected = modal?.querySelector(
      "[data-testid=task-selection-list-container] [data-item-id], [data-item-id]",
    );
    const id = selected ? taskIdFromElement(selected) : undefined;
    const anchor = modal?.querySelector<HTMLElement>(
      "[data-testid=task-main-content-container]",
    );
    if (!id || !anchor) {
      if (detailHost) {
        detailCleanup?.();
        detailHost = undefined;
        detailsReady = false;
        restore();
        hideReplaced();
      }
      detailId = "";
      return;
    }
    if (detailPending || (detailId === id && detailHost?.isConnected)) return;
    detailCleanup?.();
    detailPending = true;
    detailsReady = false;
    detailId = id;
    const ui = await createShadowRootUi(ctx, {
      inheritStyles: true,
      name: "todoist-plus-task-tools",
      position: "inline",
      anchor,
      append: "last",
      isolateEvents: ["keydown", "keyup", "keypress"],
      onMount(container) {
        const root = createRoot(container);
        root.render(
          <NativeTaskTools
            taskId={id}
            language={languageOf(document)}
            onReady={detailReady}
            onUnavailable={unavailable}
            snapshot={snapshot}
            onSnapshot={keepSnapshot}
          />,
        );
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    detailPending = false;
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
  const observer = new MutationObserver(() => {
    navUpdate?.();
    for (const [host, source] of themeHosts) applyTheme(host, source);
    if (!mainHost) void mount();
    else if (currentView() !== view || languageOf(document) !== language)
      render();
    else hideReplaced();
    void mountDetails();
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "lang", "data-theme"],
  });
  ctx.addEventListener(window, "popstate", render);
  ctx.addEventListener(window, "wxt:locationchange", render);
  ctx.onInvalidated(() => {
    disposed = true;
    observer.disconnect();
    detailCleanup?.();
    favoritesCleanup?.();
    for (const cleanup of cleanups) cleanup();
    restore();
    for (const element of nativeCurrent)
      element.removeAttribute("data-todoist-plus-native-current");
  });
  await mount();
}
