"""Native planning reads by registered task identity, independent of Tasks labels."""

from ..plus import NATIVE_FLAGS
from . import Query

FLAG_NAMES = NATIVE_FLAGS
FIELDS = ("stage", "area", "lead_days", *FLAG_NAMES)
TASKS_INDEX = "sqlite_autoindex_plan_tasks_1"
READY = Query("SELECT value FROM plan_settings WHERE key='native'", "sqlite_autoindex_plan_settings_1")
READ = Query(
    "SELECT t.external_id,s.* FROM json_each(?) AS j CROSS JOIN plan_tasks t"
    " ON t.provider='tasks' AND t.external_id=j.value JOIN plan_task_state s ON s.task_id=t.id",
    TASKS_INDEX,
)
GET = Query(
    "SELECT s.* FROM plan_tasks t JOIN plan_task_state s ON s.task_id=t.id"
    " WHERE t.provider='tasks' AND t.external_id=?",
    TASKS_INDEX,
)
REGISTER = Query(
    "INSERT INTO plan_tasks (provider,external_id,created_at) VALUES ('tasks',?,?) ON CONFLICT DO NOTHING",
    TASKS_INDEX,
)
SAVE = Query(
    f"INSERT INTO plan_task_state(task_id,{','.join(FIELDS)},rev,request_id,updated_at)"
    f" SELECT t.id,{','.join('?' for _ in FIELDS)},1,?,? FROM plan_tasks t"
    " WHERE t.provider='tasks' AND t.external_id=?"
    " AND (?=0 OR EXISTS(SELECT 1 FROM plan_task_state s WHERE s.task_id=t.id))"
    f" ON CONFLICT(task_id) DO UPDATE SET {','.join(f'{field}=excluded.{field}' for field in FIELDS)},"
    " rev=plan_task_state.rev+1,request_id=excluded.request_id,updated_at=excluded.updated_at"
    " WHERE plan_task_state.rev=? AND plan_task_state.request_id<>excluded.request_id RETURNING rev,request_id",
    TASKS_INDEX,
)

# Native rollover expires Core-owned current planning state, including hidden/deleted Tasks IDs.
# It never changes Task content or completion history. One exact old-week page is one transaction.
RESET_BATCH = 100
ENDED_WEEK = Query(
    "SELECT w.task_id,w.week_start,w.committed,w.bet,s.task_id AS state_id,s.stage,s.rev"
    " FROM plus_weeks w LEFT JOIN plan_tasks t ON t.provider='tasks' AND t.external_id=w.task_id"
    " LEFT JOIN plan_task_state s ON s.task_id=t.id"
    f" WHERE w.week_start<? ORDER BY w.week_start,w.task_id LIMIT {RESET_BATCH}",
    "plus_weeks_ended",
)
RESET_WEEK = Query(
    "UPDATE plan_task_state AS s SET stage='weekly',rev=s.rev+1,request_id=j.value->>'request_id',updated_at=?"
    " FROM json_each(?) AS j WHERE s.task_id=j.value->>'state_id' AND s.rev=j.value->>'rev'"
    " AND s.stage='committed' AND j.value->>'reset'=1"
    " AND EXISTS(SELECT 1 FROM plan_tasks t WHERE t.id=s.task_id AND t.provider='tasks'"
    " AND t.external_id=j.value->>'task_id')"
    " AND EXISTS(SELECT 1 FROM plus_weeks w WHERE w.task_id=j.value->>'task_id'"
    " AND w.week_start=j.value->>'week_start' AND w.committed=1) RETURNING task_id",
    "plus_weeks_ended",
)
FORGET_WEEK = Query(
    "DELETE FROM plus_weeks WHERE (task_id,week_start) IN"
    " (SELECT j.value->>'task_id',j.value->>'week_start' FROM json_each(?) AS j"
    " WHERE j.value->>'cleanup'=1 AND (j.value->>'reset'=0 OR EXISTS(SELECT 1 FROM plan_task_state s"
    " WHERE s.task_id=j.value->>'state_id' AND s.rev=(j.value->>'rev')+1"
    " AND s.stage='weekly' AND s.request_id=j.value->>'request_id'))) RETURNING task_id",
    "plus_weeks_ended",
)
WEEK_REMAINS = Query("SELECT task_id FROM plus_weeks WHERE week_start<? LIMIT 1", "plus_weeks_ended")
