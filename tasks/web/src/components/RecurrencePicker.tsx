import {
  REPEAT_DAYS,
  readRepeat,
  writeRepeat,
  type RepeatOptions,
  type RepeatFrequency,
} from "../recurrence-controls";
import "./recurrence-picker.css";

export function RecurrencePicker({
  value,
  date,
  disabled,
  onChange,
}: {
  value: string;
  date: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const repeat = readRepeat(value, date);
  const update = (change: Partial<RepeatOptions>) =>
    onChange(writeRepeat({ ...repeat, ...change, preserved: undefined }));
  const custom = Boolean(repeat.preserved);
  return (
    <div className="repeat-controls">
      <label>
        <span>Repeat</span>
        <select
          aria-label="Repeat"
          value={custom ? "custom" : repeat.frequency}
          disabled={disabled}
          onChange={(event) =>
            update({ frequency: event.target.value as RepeatFrequency })
          }
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Weekdays</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
          {custom && <option value="custom">Existing custom schedule</option>}
        </select>
      </label>
      {custom && (
        <p className="muted">
          Your existing schedule is unchanged. Choose a frequency to replace it.
        </p>
      )}
      {!custom && !["none", "weekdays"].includes(repeat.frequency) && (
        <>
          <label className="repeat-interval">
            <span>Every</span>
            <input
              aria-label="Repeat interval"
              type="number"
              min={1}
              max={365}
              value={repeat.interval}
              disabled={disabled}
              onChange={(event) =>
                update({
                  interval: Math.max(
                    1,
                    Math.min(365, Number(event.target.value) || 1),
                  ),
                })
              }
            />
            <span>
              {
                {
                  daily: "days",
                  weekly: "weeks",
                  monthly: "months",
                  yearly: "years",
                }[repeat.frequency as "daily" | "weekly" | "monthly" | "yearly"]
              }
            </span>
          </label>
          {!repeat.afterCompletion && repeat.frequency === "weekly" && (
            <fieldset className="repeat-days">
              <legend>On</legend>
              {REPEAT_DAYS.map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    aria-label={
                      [
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                        "Sunday",
                      ][index]
                    }
                    checked={repeat.days.includes(day)}
                    disabled={
                      disabled ||
                      (repeat.days.length === 1 && repeat.days.includes(day))
                    }
                    onChange={(event) =>
                      update({
                        days: event.target.checked
                          ? [...repeat.days, day]
                          : repeat.days.filter((value) => value !== day),
                      })
                    }
                  />
                  <span>{["M", "T", "W", "T", "F", "S", "S"][index]}</span>
                </label>
              ))}
            </fieldset>
          )}
          {!repeat.afterCompletion && repeat.frequency === "yearly" && (
            <label>
              <span>Month</span>
              <select
                aria-label="Repeat month"
                value={repeat.month}
                disabled={disabled}
                onChange={(event) =>
                  update({
                    month: Number(event.target.value),
                    monthDay: Math.min(
                      repeat.monthDay,
                      new Date(
                        Date.UTC(2000, Number(event.target.value), 0),
                      ).getUTCDate(),
                    ),
                  })
                }
              >
                {[
                  "Jan",
                  "Feb",
                  "Mar",
                  "Apr",
                  "May",
                  "Jun",
                  "Jul",
                  "Aug",
                  "Sep",
                  "Oct",
                  "Nov",
                  "Dec",
                ].map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!repeat.afterCompletion &&
            ["monthly", "yearly"].includes(repeat.frequency) && (
              <label>
                <span>Day</span>
                <select
                  aria-label="Day of month"
                  value={repeat.monthDay}
                  disabled={disabled}
                  onChange={(event) =>
                    update({ monthDay: Number(event.target.value) })
                  }
                >
                  {Array.from(
                    {
                      length:
                        repeat.frequency === "yearly"
                          ? new Date(
                              Date.UTC(2000, repeat.month, 0),
                            ).getUTCDate()
                          : 31,
                    },
                    (_, index) => (
                      <option key={index + 1} value={index + 1}>
                        {index + 1}
                      </option>
                    ),
                  )}
                  {repeat.frequency === "monthly" && (
                    <option value={-1}>Last day</option>
                  )}
                </select>
              </label>
            )}
          <label className="repeat-anchor">
            <input
              type="checkbox"
              checked={repeat.afterCompletion}
              disabled={disabled}
              onChange={(event) =>
                update({ afterCompletion: event.target.checked })
              }
            />
            Count from completion
          </label>
        </>
      )}
    </div>
  );
}
