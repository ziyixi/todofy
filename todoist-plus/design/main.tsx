import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Calendar,
  CalendarDays,
  CheckCheck,
  ChevronDown,
  Hash,
  Inbox,
  LayoutList,
  Moon,
  Search,
  Sun,
  Target,
} from "lucide-react";
import { App } from "../src/App";
import { words } from "../src/i18n";
import type { Language, View } from "../src/model";
import { createPrototype } from "./fixture";
import "../src/styles.css";
import "./prototype.css";
const actions = createPrototype();
function Prototype() {
  const [view, setView] = useState<View>("plan");
  const [language, setLanguage] = useState<Language>("en");
  const [dark, setDark] = useState(false);
  const [nativeId, setNativeId] = useState("");
  const text = words(language);
  return (
    <div className="plus-prototype" data-theme={dark ? "dark" : "light"}>
      <aside className="prototype-sidebar">
        <div className="prototype-owner">
          <span className="prototype-avatar">P</span>Personal{" "}
          <ChevronDown size={13} />
        </div>
        <nav>
          <button>
            <Search size={19} />
            {language === "zh" ? "搜索" : "Search"}
          </button>
          <button>
            <Inbox size={19} />
            {language === "zh" ? "收件箱" : "Inbox"}
            <small>8</small>
          </button>
          <button>
            <Calendar size={19} />
            {text.today}
            <small>3</small>
          </button>
          <button>
            <CalendarDays size={19} />
            {language === "zh" ? "预览" : "Upcoming"}
          </button>
          <div className="prototype-nav-gap" />
          <button
            className={view === "plan" ? "active" : ""}
            onClick={() => setView("plan")}
          >
            <LayoutList size={19} />
            {text.plan}
          </button>
          <button
            className={view === "focus" ? "active" : ""}
            onClick={() => setView("focus")}
          >
            <Target size={19} />
            {text.focus}
          </button>
          <div className="prototype-nav-heading">
            {language === "zh" ? "收藏" : "Favorites"}
          </div>
          <button>
            <Hash size={19} />
            Email Inbox
          </button>
          <div className="prototype-nav-heading">
            {language === "zh" ? "我的项目" : "My projects"}
          </div>
          <button>
            <Hash size={19} />
            {language === "zh" ? "工作" : "Work"}
          </button>
          <button>
            <Hash size={19} />
            {language === "zh" ? "生活" : "Personal"}
          </button>
        </nav>
        <div className="prototype-controls">
          <small>LOCAL · SYNTHETIC TASKS</small>
          <div>
            <button onClick={() => setDark(!dark)} aria-label="Switch theme">
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              onClick={() => setLanguage(language === "en" ? "zh" : "en")}
            >
              {language === "en" ? "中文" : "English"}
            </button>
          </div>
        </div>
      </aside>
      <main>
        <App
          actions={actions}
          view={view}
          onViewChange={setView}
          language={language}
          onOpenTask={setNativeId}
          onSettings={() => setNativeId("settings")}
        />
        {nativeId && (
          <div className="prototype-native-message" role="status">
            <CheckCheck size={15} />
            {nativeId === "settings"
              ? "Prototype: connection is simulated."
              : "Prototype: native Todoist task opens here."}
            <button onClick={() => setNativeId("")}>×</button>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Prototype />);
