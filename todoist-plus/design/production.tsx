import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Calendar,
  ChevronDown,
  Hash,
  Inbox,
  LayoutList,
  Search,
  Target,
} from "lucide-react";
import { App } from "../src/App";
import type { View } from "../src/model";
import { createPrototype } from "./fixture";
import "../src/styles.css";
import "./prototype.css";

// Synthetic preview options: ?lang=zh, ?review (the review task's link) and ?sunday.
const options = new URLSearchParams(location.search);
const actions = createPrototype(
  true,
  options.has("sunday") ? "2026-10-18" : undefined,
);

function ProductionPreview() {
  const [view, setView] = useState<View>("plan");
  const [notice, setNotice] = useState("");
  return (
    <div className="plus-prototype">
      <aside className="prototype-sidebar">
        <div className="prototype-owner">
          <span className="prototype-avatar">P</span>Personal{" "}
          <ChevronDown size={13} />
        </div>
        <nav>
          <button>
            <Search size={19} />
            Search
          </button>
          <button>
            <Inbox size={19} />
            Inbox
          </button>
          <button onClick={() => setView("focus")}>
            <Calendar size={19} />
            Today
          </button>
          <div className="prototype-nav-gap" />
          <button
            className={view === "plan" ? "active" : ""}
            onClick={() => setView("plan")}
          >
            <span className="plus-nav-icon">
              <LayoutList size={18} />
            </span>
            Plan
          </button>
          <button
            className={view === "focus" ? "active" : ""}
            onClick={() => setView("focus")}
          >
            <span className="plus-nav-icon">
              <Target size={18} />
            </span>
            Focus
          </button>
          <div className="prototype-nav-heading">My projects</div>
          <button>
            <Hash size={19} />
            Work
          </button>
          <button>
            <Hash size={19} />
            Personal
          </button>
        </nav>
        <div className="prototype-controls">
          <small>PRODUCTION COMPONENTS · SYNTHETIC DATA</small>
        </div>
      </aside>
      <main>
        <App
          actions={actions}
          view={view}
          onViewChange={setView}
          language={options.get("lang") === "zh" ? "zh" : "en"}
          review={options.has("review")}
          onOpenTask={() =>
            setNotice("Synthetic native task link. No real task is opened.")
          }
          onSettings={() =>
            setNotice("Synthetic connection. No credentials are used.")
          }
        />
        {notice && (
          <div className="prototype-native-message" role="status">
            {notice}
            <button onClick={() => setNotice("")}>Close</button>
          </div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ProductionPreview />);
