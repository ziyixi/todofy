import { useRef } from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown, Flag } from "lucide-react";
import "./property-pickers.css";

const PRIORITIES = [
  { value: 1, label: "Priority 1", color: "#d1453b" },
  { value: 2, label: "Priority 2", color: "#eb8909" },
  { value: 3, label: "Priority 3", color: "#246fe0" },
  { value: 4, label: "Priority 4", color: "#808080" },
];

export function PriorityPicker({
  value,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  value: number;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: number) => void;
}) {
  const portal = useRef<HTMLElement | null>(null);
  const selected =
    PRIORITIES.find((item) => item.value === value) ?? PRIORITIES[3]!;
  return (
    <div className="task-property">
      <span className="property-heading">Priority</span>
      <Select.Root
        value={value}
        disabled={disabled}
        open={open}
        onOpenChange={onOpenChange}
        modal={false}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <Select.Trigger
          className="property-trigger"
          aria-label="Priority"
          ref={(element) => {
            portal.current = element?.closest("dialog") ?? null;
          }}
        >
          <Flag
            size={16}
            color={selected.color}
            fill={value < 4 ? selected.color : "none"}
          />
          <span className="property-value">{selected.label}</span>
          <ChevronDown size={12} className="property-chevron" />
        </Select.Trigger>
        <Select.Portal container={portal}>
          <Select.Positioner
            align="start"
            sideOffset={5}
            alignItemWithTrigger={false}
            className="property-positioner"
          >
            <Select.Popup className="property-popup priority-popup">
              <Select.List>
                {PRIORITIES.map((item) => (
                  <Select.Item
                    key={item.value}
                    value={item.value}
                    className="property-option"
                  >
                    <Flag
                      size={16}
                      color={item.color}
                      fill={item.value < 4 ? item.color : "none"}
                    />
                    <Select.ItemText className="property-value">
                      {item.label}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={14} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
