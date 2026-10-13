import { createRoot, type Root } from "react-dom/client";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { LayoutList, Target } from "lucide-react";
import { App } from "./App";
import { todoistTaskUrl } from "./domain";
import { NativeTaskTools } from "./NativeTaskTools";
import { extensionActions, openOptions } from "./client";
import { words } from "./i18n";
import type { Language, PlanState, View } from "./model";

const viewParam = "todoist-plus";
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

export async function mountTodoist(ctx: ContentScriptContext) {
  const hidden = new Map<
    HTMLElement,
    { hidden: string | null; display: string; priority: string }
  >();
  const themeHosts = new Map<HTMLElement, HTMLElement>();
  const cleanups: (() => void)[] = [];
  let content: HTMLElement | undefined;
  let mainHost: HTMLElement | undefined;
  let mainRoot: Root | undefined;
  let plan: PlanState | undefined;
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
  function hideReplaced() {
    if (view && content && mainHost) {
      for (const child of Array.from(content.children))
        if (child instanceof HTMLElement && child !== mainHost) hide(child);
    }
    if (!plan?.configured || !mainHost?.isConnected) return;
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "[data-testid=app-sidebar-scrollable-container] a[href], #left_menu a[href]",
    )) {
      const slug = new URL(link.href).pathname.match(
        /\/app\/filter\/([^/]+)$/u,
      )?.[1];
      if (
        slug &&
        plan.hiddenFilterIds.some(
          (id) => slug === id || slug.endsWith(`-${id}`),
        )
      )
        hide(link.closest("li") ?? link);
    }
    if (!detailsReady || !detailHost?.isConnected) return;
    const labels = plan.managedLabels.filter(
      (label) => !["office", "home"].includes(label.role),
    );
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "[data-testid=task-details-modal] a[href*='/app/label/']",
    )) {
      const slug = new URL(link.href).pathname.match(
        /\/app\/label\/([^/]+)$/u,
      )?.[1];
      if (
        slug &&
        labels.some(
          (label) => slug === label.id || slug.endsWith(`-${label.id}`),
        )
      )
        hide(link);
    }
  }
  const ready = (next?: PlanState) => {
    plan = next;
    if (!next?.configured) detailsReady = false;
    restore();
    hideReplaced();
  };
  const unavailable = () => ready();
  const detailReady = (next?: PlanState) => {
    detailsReady = Boolean(next?.configured);
    if (next) plan = next;
    restore();
    hideReplaced();
  };
  function render() {
    if (!content || !mainRoot || !mainHost) return;
    restore();
    view = currentView();
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
          onReady={ready}
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
    const sidebar =
      document.querySelector<HTMLElement>(
        "[data-testid=app-sidebar-scrollable-container]",
      ) ?? document.querySelector<HTMLElement>("#left_menu");
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
                  {item === "plan" ? (
                    <LayoutList size={19} />
                  ) : (
                    <Target size={19} />
                  )}
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
    themeHosts.set(navUi.shadowHost, sidebar);
    applyTheme(navUi.shadowHost, sidebar);
    cleanups.push(() => navUi.remove());
    mounting = false;
    render();
    if (!view) {
      void extensionActions
        .load()
        .then((next) => {
          if (!disposed) ready(next.plan);
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
    for (const cleanup of cleanups) cleanup();
    restore();
  });
  await mount();
}
