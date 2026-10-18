"""Bounded Todoist Plus state, never a second copy of Todoist tasks."""

SETTINGS = "SELECT * FROM plus_settings WHERE id = 1"
SAVE_SETTINGS = (
    "INSERT INTO plus_settings(id,mapping,timezone,week_start,enabled) VALUES(1,?,?,?,1) "
    "ON CONFLICT(id) DO UPDATE SET mapping=excluded.mapping,timezone=excluded.timezone,"
    "week_start=excluded.week_start,enabled=1"
)
ADVANCE_WEEK = "UPDATE plus_settings SET week_start=? WHERE id=1"
# The receipts the releases before runtime/plus_receipts.py wrote, read-only and by primary key, for request IDs
# of its window (created_at >= ?). Nothing writes plus_actions any more.
LEGACY_ACTION = "SELECT request_hash,commands,response FROM plus_actions WHERE request_id=? AND created_at>=?"
# A CompleteTask receipt and the FlowDay settlement frozen for it ('focus:' + its request ID).
LEGACY_COMPLETION = (
    "SELECT request_id,request_hash,commands,response,created_at FROM plus_actions "
    "WHERE request_id IN (?,?) AND created_at>=?"
)
# Only tasks with a mark are remembered. The marks follow the latest page scan or write, but a row never moves
# back to an older week, so a choice recorded for the next week on Sunday survives that day's scans and later
# writes, which remember the task under the ending week.
REMEMBER_WEEK = (
    "INSERT INTO plus_weeks(task_id,week_start,committed,bet) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET "
    "week_start=MAX(plus_weeks.week_start,excluded.week_start),committed=excluded.committed,bet=excluded.bet "
    "WHERE plus_weeks.week_start<excluded.week_start OR plus_weeks.committed!=excluded.committed "
    "OR plus_weeks.bet!=excluded.bet"
)
# A write that leaves a task with neither mark: nothing for Monday to reset, and no choice kept for next week.
FORGET_TASK = "DELETE FROM plus_weeks WHERE task_id=?"
RESET_BATCH = 5
ENDED_WEEK = f"SELECT * FROM plus_weeks WHERE week_start < ? ORDER BY week_start,task_id LIMIT {RESET_BATCH}"
FORGET_WEEK = "DELETE FROM plus_weeks WHERE task_id=? AND week_start=?"
# Choices already recorded for a week after the given one (the plus_weeks_ended index), IDs only.
NEXT_WEEK = "SELECT task_id FROM plus_weeks WHERE week_start > ? ORDER BY week_start,task_id LIMIT 100"
