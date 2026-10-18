import { useRef, useState } from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { TASK_COLORS } from "../../../shared/colors";
import "./color-detail.css";

export function ColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = TASK_COLORS.find(
    (color) => color.hex === value.toLowerCase(),
  );
  const custom =
    value && !selected ? { name: `Custom ${value}`, hex: value } : undefined;
  const colors = custom ? [custom, ...TASK_COLORS] : TASK_COLORS;
  return (
    <div className="catalog-color-field">
      <span className="property-heading">Color</span>
      <Select.Root
        value={selected?.hex ?? value}
        open={open}
        modal={false}
        onOpenChange={setOpen}
        onValueChange={(color) => {
          if (color) onChange(color);
        }}
        disabled={disabled}
      >
        <Select.Trigger
          ref={trigger}
          className="color-picker-trigger"
          aria-label="Color"
        >
          <span
            className="color-swatch"
            style={{ background: value || "#808080" }}
          />
          <span>{selected?.name || custom?.name || "Charcoal"}</span>
          <ChevronDown size={15} />
        </Select.Trigger>
        <Select.Portal
          container={trigger.current?.closest("dialog") ?? undefined}
        >
          <Select.Positioner
            positionMethod="fixed"
            align="start"
            alignItemWithTrigger={false}
            sideOffset={5}
            className="color-picker-positioner"
          >
            <Select.Popup className="color-picker-popup">
              <Select.List className="color-picker-list" aria-label="Colors">
                {colors.map((color) => (
                  <Select.Item
                    key={color.hex}
                    value={color.hex}
                    label={color.name}
                    className="color-picker-option"
                  >
                    <Select.ItemIndicator
                      keepMounted
                      className="color-picker-check"
                    >
                      <Check size={13} />
                    </Select.ItemIndicator>
                    <span
                      className="color-swatch"
                      style={{ background: color.hex }}
                    />
                    <Select.ItemText>{color.name}</Select.ItemText>
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
