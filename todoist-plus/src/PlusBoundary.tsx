import { Component, type ReactNode } from "react";
import type { Language } from "./model";

interface Props {
  language: Language;
  /** The panel's own classes, so the line sits where the panel would. */
  className: string;
  /** Leaves Plus and shows native Todoist again. */
  onBack: () => void;
  /** Told that it happened, never what: for the options page's status line. */
  onError?: () => void;
  children: ReactNode;
}

/** A render failure shows one quiet way back instead of a blank panel over hidden Todoist. */
export class PlusBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError?.();
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const zh = this.props.language === "zh";
    return (
      <div className={this.props.className}>
        <p className="plus-muted plus-crash" role="alert">
          <button onClick={this.props.onBack}>
            {zh ? "返回 Todoist" : "Back to Todoist"}
          </button>
          {" / "}
          <button onClick={() => location.reload()}>
            {zh ? "重新加载" : "Reload"}
          </button>
        </p>
      </div>
    );
  }
}
