"""Bounded Todoist Plus state, never a second copy of Todoist tasks."""

SETTINGS = "SELECT * FROM plus_settings WHERE id = 1"
SAVE_SETTINGS = (
    "INSERT INTO plus_settings(id,mapping,timezone,week_start,enabled) VALUES(1,?,?,?,1) "
    "ON CONFLICT(id) DO UPDATE SET mapping=excluded.mapping,timezone=excluded.timezone,"
    "week_start=excluded.week_start,enabled=1"
)
ADVANCE_WEEK = "UPDATE plus_settings SET week_start=? WHERE id=1"
CONNECTION = "SELECT id FROM plus_connections WHERE token_sha256=? AND revoked=0"
CONNECTIONS = "SELECT id,display_name,revoked FROM plus_connections ORDER BY created_at DESC LIMIT 30"
CREATE_CONNECTION = (
    "INSERT INTO plus_connections(id,display_name,token_sha256,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING"
)
REVOKE_CONNECTION = "UPDATE plus_connections SET revoked=1 WHERE id=?"
ACTION = "SELECT * FROM plus_actions WHERE request_id=?"
START_ACTION = "INSERT INTO plus_actions(request_id,request_hash,commands,created_at) VALUES(?,?,?,?)"
FINISH_ACTION = "UPDATE plus_actions SET response=? WHERE request_id=?"
REMEMBER_WEEK = (
    "INSERT INTO plus_weeks(task_id,week_start,committed,bet) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET "
    "week_start=excluded.week_start,committed=excluded.committed,bet=excluded.bet WHERE "
    "plus_weeks.week_start!=excluded.week_start OR plus_weeks.committed!=excluded.committed "
    "OR plus_weeks.bet!=excluded.bet"
)
RESET_BATCH = 5
ENDED_WEEK = f"SELECT * FROM plus_weeks WHERE week_start < ? ORDER BY week_start,task_id LIMIT {RESET_BATCH}"
FORGET_WEEK = "DELETE FROM plus_weeks WHERE task_id=? AND week_start=?"

REPLACE_ACTION_COMMANDS = "UPDATE plus_actions SET commands=? WHERE request_id=?"
