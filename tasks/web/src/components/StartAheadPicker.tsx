import { useState } from "react";
import { Clock3 } from "lucide-react";

export function StartAheadPicker({
  days,
  disabled,
  deadline,
  onChange,
}: {
  days: number;
  deadline: string;
  disabled: boolean;
  onChange: (days: number) => void;
}) {
  const [unit, setUnit] = useState(() =>
    days > 0 && days % 7 === 0 ? "weeks" : "days",
  );
  const scale = unit === "weeks" ? 7 : 1;
  return (
    <label className="start-ahead-field">
      <span className="property-heading">Start ahead</span>
      <span className="start-ahead-controls">
        <Clock3 size={16} aria-hidden="true" />
        <input
          aria-label="Start ahead amount"
          type="number"
          min={0}
          max={Math.floor(365 / scale)}
          value={days ? days / scale : ""}
          placeholder="0"
          disabled={disabled}
          onChange={(event) =>
            onChange(
              Math.min(
                365,
                Math.max(0, Number(event.target.value) || 0) * scale,
              ),
            )
          }
        />
        <select
          aria-label="Start ahead unit"
          value={unit}
          disabled={disabled}
          onChange={(event) => {
            const nextScale = event.target.value === "weeks" ? 7 : 1;
            const amount = days / scale;
            setUnit(event.target.value);
            onChange(
              Math.min(365, Math.max(0, Math.round(amount * nextScale))),
            );
          }}
        >
          <option value="days">days</option>
          <option value="weeks">weeks</option>
        </select>
      </span>
      <small>
        {deadline
          ? "Appears in Start now before the deadline."
          : "Add a deadline to enable Start now."}
      </small>
    </label>
  );
}
