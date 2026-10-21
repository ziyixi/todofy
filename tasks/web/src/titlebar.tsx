import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { Search } from "lucide-react";

const OVERLAY = "(display-mode: window-controls-overlay)";

/**
 * Whether the installed app draws its own title bar (Window Controls Overlay, which the owner toggles in
 * Chrome's title bar). The query's `change` event follows the toggle both ways; `geometrychange` stops once
 * the overlay is hidden. While it is on, `html.titlebar-overlay` carries the layout (styles.css) and the theme
 * colour is white, so the controls Chrome draws at the right sit on the strip's white.
 */
export function useTitlebarOverlay(): boolean {
  const [overlay, setOverlay] = useState(
    () => window.matchMedia(OVERLAY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(OVERLAY);
    const change = () => setOverlay(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  // Before paint, so the strip never shows over the normal layout.
  useLayoutEffect(() => {
    if (!overlay) return;
    const root = document.documentElement;
    const theme = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const color = theme?.content;
    root.classList.add("titlebar-overlay");
    if (theme) theme.content = "#ffffff";
    return () => {
      root.classList.remove("titlebar-overlay");
      if (theme && color) theme.content = color;
    };
  }, [overlay]);
  return overlay;
}

/**
 * The strip over the old title bar: it drags the window, and holds the one search field. The current
 * page's refresh button moves into it by CSS (`.view-refresh`, `.plus-refresh`).
 */
export function TitleBar({
  search,
  searching,
  onSearch,
  searchRef,
}: {
  /** Search's query; the host clears it when another page shows. */
  search: string;
  /** Search is the current page. */
  searching: boolean;
  /** Typing on another page goes to Search. */
  onSearch: (text: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  // Opening Search, from the sidebar too, puts the caret here, as the page's own field does.
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching, searchRef]);
  return (
    <div className="titlebar">
      <div className="titlebar-area">
        <label className="titlebar-search">
          <Search size={15} />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search tasks"
            aria-label="Search tasks"
          />
          <kbd>/</kbd>
        </label>
      </div>
    </div>
  );
}
