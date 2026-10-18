import { Component, type ReactNode } from "react";

/**
 * Lazily loaded parts fail to load once a newer deploy has replaced their chunk. Instead of blanking the
 * whole app, this one place asks for a reload, which fetches the current build.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p className="loading-state" role="alert">
        Tasks was updated.
        <button
          className="text-button"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </p>
    );
  }
}
