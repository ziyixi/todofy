import { Component, type ReactNode } from "react";

/** Chrome, Firefox and Safari each word a lazy chunk that no longer loads differently. */
const MISSING_CHUNK =
  /dynamically imported module|Importing a module script failed/i;

/** Asks for a reload, which loads the current build. */
export function ReloadPrompt({ updated }: { updated: boolean }) {
  return (
    <p className="loading-state" role="alert">
      {updated
        ? "Tasks was updated."
        : "This part of Tasks could not be shown."}
      <button className="text-button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </p>
  );
}

/**
 * Lazily loaded parts fail to load once a newer deploy has replaced their chunk. Instead of blanking the
 * whole app, this one place asks for a reload, which fetches the current build. A changed `resetKey`, such
 * as the next route, clears the failure so one page's error does not stay on the pages after it. A `quiet`
 * boundary, around a part running behind another page, shows nothing for a failure.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; quiet?: boolean },
  { failed: boolean; updated: boolean; resetKey?: string }
> {
  override state = {
    failed: false,
    updated: false,
    resetKey: this.props.resetKey,
  };
  static getDerivedStateFromError(error: unknown) {
    return {
      failed: true,
      updated: error instanceof Error && MISSING_CHUNK.test(error.message),
    };
  }
  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { resetKey?: string },
  ) {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, updated: false, resetKey: props.resetKey };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    return <ReloadPrompt updated={this.state.updated} />;
  }
}
