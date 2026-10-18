import { useId, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  CalendarDays,
  CalendarRange,
  ChevronDown,
  Clock,
  Repeat2,
  Sun,
  Sunrise,
  Sofa,
  CalendarArrowUp,
  X,
} from "lucide-react";
import { api, describeError } from "../api";
import { dateLabel, shiftDate, todayDate } from "../dates";
import { repeatLabel } from "../recurrence-controls";
import { DateCalendar } from "./DateCalendar";
import { RecurrencePicker } from "./RecurrencePicker";
import "./property-pickers.css";

interface Props {
  label: "Date" | "Deadline";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  disabled: boolean;
  timeZone: string;
  onChange: (value: string) => Promise<void> | void;
  text?: string;
  onTextChange?: (value: string) => void;
  onParse?: () => Promise<void>;
  preview?: string;
  time?: string;
  onTimeChange?: (value: string) => Promise<void>;
  recurrence?: string;
  onRecurrenceChange?: (value: string) => void;
  anchor?: HTMLElement;
}

export function SchedulePicker({
  label,
  open,
  onOpenChange,
  value,
  disabled,
  timeZone,
  onChange,
  text,
  onTextChange,
  onParse,
  preview,
  time = "",
  onTimeChange,
  recurrence,
  onRecurrenceChange,
  anchor,
}: Props) {
  const [deadlineText, setDeadlineText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [repeatExpanded, setRepeatExpanded] = useState(false);
  const portal = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputHelpId = useId();
  const timePanelId = useId();
  const repeatPanelId = useId();
  const today = todayDate(new Date(), timeZone || undefined);
  const weekday = new Date(`${today}T12:00:00`).getDay();
  const isDeadline = label === "Deadline";
  const inputText = isDeadline ? deadlineText : text || "";
  const busy = disabled || parsing;
  const repeatText = repeatLabel(recurrence || "");
  async function choose(date: string) {
    setError("");
    try {
      await onChange(date);
      onOpenChange(false);
    } catch (reason) {
      setError(describeError(reason));
    }
  }
  async function parseText() {
    if (!inputText.trim()) return;
    setError("");
    setParsing(true);
    try {
      if (onParse) {
        await onParse();
        return;
      }
      const result = await api.previewDate({ text: inputText, timeZone });
      if (result.recurrence || result.dueDatetime) {
        setError(
          "A deadline uses a single date. Add a time or repeat rule under Date.",
        );
        return;
      }
      await choose(result.dueDate);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setParsing(false);
    }
  }
  const choices = [
    { label: "Today", date: today, Icon: Sun, color: "#058527" },
    {
      label: "Tomorrow",
      date: shiftDate(today, 1),
      Icon: Sunrise,
      color: "#ad6200",
    },
    {
      label: "This weekend",
      date: shiftDate(today, (6 - weekday + 7) % 7),
      Icon: Sofa,
      color: "#246fe0",
    },
    {
      label: "Next week",
      date: shiftDate(today, (8 - weekday) % 7 || 7),
      Icon: CalendarArrowUp,
      color: "#a146ba",
    },
  ];
  return (
    <div className="task-property">
      {!anchor && <span className="property-heading">{label}</span>}
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setTimeExpanded(false);
            setRepeatExpanded(false);
          }
          onOpenChange(next);
        }}
      >
        {!anchor && (
          <Popover.Trigger
            className={`property-trigger${value ? " has-date" : ""}`}
            aria-label={label}
            disabled={busy}
            style={
              value
                ? {
                    color:
                      value < today
                        ? "#d1453b"
                        : value === today
                          ? "#058527"
                          : value === shiftDate(today, 1)
                            ? "#ad6200"
                            : "#692fc2",
                  }
                : undefined
            }
            ref={(element: HTMLButtonElement | null) => {
              portal.current = element?.closest("dialog") ?? null;
            }}
          >
            {isDeadline ? (
              <CalendarRange size={16} />
            ) : (
              <CalendarDays size={16} />
            )}
            <span className="property-value">
              {value
                ? `${dateLabel(value, today)}${time ? ` · ${time}` : ""}`
                : isDeadline
                  ? "Set deadline"
                  : "No date"}
            </span>
            {recurrence && <Repeat2 size={13} aria-label="Repeating task" />}
            <ChevronDown size={12} className="property-chevron" />
          </Popover.Trigger>
        )}
        <Popover.Portal container={anchor?.closest("dialog") ?? portal}>
          <Popover.Positioner
            anchor={anchor}
            align="start"
            sideOffset={5}
            className="property-positioner"
          >
            <Popover.Popup
              className="property-popup schedule-popup"
              initialFocus={input}
              finalFocus={anchor ? () => anchor : true}
              aria-label={`${label} picker`}
            >
              <div className="schedule-search">
                <input
                  ref={input}
                  aria-label={isDeadline ? "Deadline text" : "Schedule"}
                  placeholder="YYYY-MM-DD or tomorrow"
                  aria-describedby={inputHelpId}
                  value={inputText}
                  disabled={busy}
                  onChange={(event) => {
                    setError("");
                    if (isDeadline) setDeadlineText(event.target.value);
                    else onTextChange?.(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      void parseText();
                    }
                  }}
                />
                {inputText.trim() && (
                  <button
                    type="button"
                    className="schedule-parse"
                    disabled={busy}
                    onClick={() => void parseText()}
                  >
                    Apply
                  </button>
                )}
              </div>
              <p className="schedule-input-help" id={inputHelpId}>
                YYYY-MM-DD, e.g. 2030-04-15, or tomorrow.
              </p>
              {preview && (
                <p className="schedule-preview" role="status">
                  {preview}
                </p>
              )}
              {error && (
                <p className="schedule-error" role="alert">
                  {error}
                </p>
              )}
              <div className="schedule-choices">
                {choices.map(({ label: title, date, Icon, color }) => (
                  <button
                    type="button"
                    className="property-option"
                    key={title}
                    disabled={busy}
                    onClick={() => void choose(date)}
                  >
                    <Icon size={17} color={color} />
                    <span className="property-value">{title}</span>
                    <small>
                      {new Date(`${date}T12:00:00`).toLocaleDateString("en", {
                        weekday: "short",
                      })}
                    </small>
                  </button>
                ))}
                <button
                  type="button"
                  className="property-option"
                  disabled={busy}
                  onClick={() => void choose("")}
                >
                  <X size={17} />
                  <span>No {isDeadline ? "deadline" : "date"}</span>
                </button>
              </div>
              <DateCalendar
                key={value || today}
                value={value}
                today={today}
                disabled={busy}
                onChange={(date) => void choose(date)}
              />
              {!isDeadline && (onTimeChange || onRecurrenceChange) && (
                <div className="schedule-extra">
                  {onTimeChange && (
                    <>
                      <button
                        type="button"
                        className="schedule-disclosure"
                        aria-label="Time options"
                        aria-expanded={timeExpanded}
                        aria-controls={timePanelId}
                        disabled={busy}
                        onClick={() => setTimeExpanded(!timeExpanded)}
                      >
                        <Clock size={15} />
                        <span>{time ? `Time · ${time}` : "Add time"}</span>
                        <ChevronDown size={13} />
                      </button>
                      {timeExpanded && (
                        <div className="schedule-time" id={timePanelId}>
                          <label>
                            <span>Time</span>
                            <input
                              aria-label="Time"
                              type="time"
                              value={time}
                              disabled={!value || busy}
                              onChange={(event) =>
                                void onTimeChange?.(event.target.value)
                              }
                            />
                          </label>
                          {timeZone && (
                            <span className="schedule-zone">
                              {timeZone.replaceAll("_", " ")}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {onRecurrenceChange && (
                    <>
                      <button
                        type="button"
                        className="schedule-disclosure"
                        aria-label="Repeat options"
                        aria-expanded={repeatExpanded}
                        aria-controls={repeatPanelId}
                        disabled={busy}
                        onClick={() => setRepeatExpanded(!repeatExpanded)}
                      >
                        <Repeat2 size={15} />
                        <span title={repeatText}>{repeatText}</span>
                        <ChevronDown size={13} />
                      </button>
                      {repeatExpanded && (
                        <div className="schedule-repeat" id={repeatPanelId}>
                          <RecurrencePicker
                            value={recurrence || ""}
                            date={value || today}
                            disabled={busy}
                            onChange={onRecurrenceChange}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
