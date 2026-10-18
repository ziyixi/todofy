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
