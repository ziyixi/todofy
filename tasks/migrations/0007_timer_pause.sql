-- When a paused session paused (ms), so a RESUME can take effect from that moment; NULL unless paused.
ALTER TABLE focus_timer ADD COLUMN paused_at INTEGER;
