"""Prepare the one-time native planning cutover from private, metadata-only input."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from todofy.core import plus
from todofy.core.native_plan import FLAG_NAMES, state_from_labels


def literal(value: Any) -> str:
    if isinstance(value, int):
        return str(value)
    return "CAST(X'" + str(value).encode().hex() + "' AS TEXT)"


def prepare(data: dict[str, Any]) -> dict[str, Any]:
    """No network or task text: IDs, memberships and the saved role mapping only."""
    mapping = data["mapping"]["labels"]
    labels = {row["id"]: row["title"] for row in data["labels"]}
    reserved_ids = {binding["id"] for binding in mapping}
    reserved_ids.update(row["id"] for row in data["labels"] if row["title"] in plus.NATIVE_ROLES)
    if not reserved_ids <= labels.keys():
        raise ValueError("PLANNING_LABEL_IDENTITY_CHANGED")
    for binding in mapping:
        if labels[binding["id"]] != binding["label"]:
            raise ValueError("PLANNING_LABEL_IDENTITY_CHANGED")
    retired_filters = plus.replaced_filters(
        [{"id": row["id"], "query": row["query"]} for row in data["filters"]], mapping, set(labels.values())
    )
    now = int(data["now"])
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    state_sql = [
        "SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM plan_settings WHERE key='native'"
        " AND value->>'initialized'=1) THEN 1 ELSE json('NATIVE_PLAN_ALREADY_INITIALIZED') END;"
    ]
    state_count = 0
    default = state_from_labels([])
    fields = ("stage", "area", "lead_days", *FLAG_NAMES)
    for task in data["tasks"]:
        task_id = plus.check_id(task["id"])
        memberships = json.loads(task["label_ids"]) if isinstance(task["label_ids"], str) else task["label_ids"]
        if not set(memberships) <= labels.keys():
            raise ValueError("TASK_LABEL_IDENTITY_MISSING")
        state = state_from_labels([labels[key] for key in memberships], mapping)
        if state == default:
            continue
        state_count += 1
        identity = literal(task_id)
        request_id = literal("import:" + digest[:32] + ":" + task_id)
        values = [literal(int(state[field]) if field in FLAG_NAMES else state[field]) for field in fields]
        state_sql.extend(
            [
                "INSERT INTO plan_tasks(provider,external_id,created_at) VALUES('tasks',"
                f"{identity},{now}) ON CONFLICT DO NOTHING;",
                f"INSERT INTO plan_task_state(task_id,{','.join(fields)},rev,request_id,updated_at)"
                f" SELECT id,{','.join(values)},1,{request_id},{now} FROM plan_tasks"
                f" WHERE provider='tasks' AND external_id={identity} ON CONFLICT(task_id) DO UPDATE SET"
                " request_id=CASE WHEN plan_task_state.request_id=excluded.request_id"
                " THEN plan_task_state.request_id ELSE json('NATIVE_PLAN_STATE_CHANGED') END;",
            ]
        )
        if state["stage"] == "committed":
            state_sql.append(
                "INSERT INTO plus_weeks(task_id,week_start,committed,bet)"
                f" VALUES({identity},{literal(data['week_start'])},1,0) ON CONFLICT(task_id) DO NOTHING;"
            )
    ids = ",".join(literal(value) for value in sorted(reserved_ids)) or "NULL"
    filters = ",".join(literal(value) for value in sorted(retired_filters)) or "NULL"
    retire_sql = [
        "UPDATE tasks SET label_ids=(SELECT json_group_array(value) FROM json_each(tasks.label_ids)"
        f" WHERE value NOT IN({ids})),revision=revision+1,updated_at={now * 1000}"
        f" WHERE EXISTS(SELECT 1 FROM json_each(tasks.label_ids) WHERE value IN({ids}));",
        f"UPDATE labels SET deleted_at={now * 1000},updated_at={now * 1000},revision=revision+1"
        f" WHERE id IN({ids}) AND deleted_at IS NULL;",
        f"UPDATE filters SET deleted_at={now * 1000},updated_at={now * 1000},revision=revision+1"
        f" WHERE id IN({filters}) AND deleted_at IS NULL;",
    ]
    activate_sql = [
        "INSERT INTO plus_settings(id,mapping,timezone,week_start,enabled)"
        f' VALUES(1,\'{{"labels":[],"etag":"native"}}\',{literal(data["timezone"])},'
        f"{literal(data['week_start'])},1) ON CONFLICT(id) DO NOTHING;",
        "INSERT INTO plan_settings(key,value,updated_at) VALUES('native','{\"initialized\":true}',"
        f"{now}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;",
    ]
    mailbox_sql = []
    if "mailbox_task_ids" in data:
        adopted = sorted({plus.check_id(value) for value in data["mailbox_task_ids"]})
        if not set(adopted) <= {row["id"] for row in data["tasks"]}:
            raise ValueError("MAILBOX_TASK_IDENTITY_MISSING")
        mailbox_sql = [
            state_sql[0],
            "UPDATE summaries SET triaged_at=created_at WHERE imported=0 AND task_id<>'' AND triaged_at IS NULL;",
            "UPDATE summaries SET triaged_at=NULL WHERE imported=0 AND task_id<>''"
            f" AND task_id IN({','.join(literal(value) for value in adopted) or 'NULL'});",
        ]
    return {
        "state_sql": "\n".join(state_sql) + "\n",
        "retire_sql": "\n".join(retire_sql) + "\n",
        "activate_sql": "\n".join(activate_sql) + "\n",
        "mailbox_sql": "\n".join(mailbox_sql) + "\n",
        "counts": {
            "planning_states": state_count,
            "retired_labels": len(reserved_ids),
            "retired_filters": len(retired_filters),
            "adopted_mail_tasks": len(data.get("mailbox_task_ids", [])),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepared = prepare(json.loads(args.input.read_text()))
    args.output.mkdir(mode=0o700)
    for key in ("state", "retire", "mailbox", "activate"):
        path = args.output / (key + ".sql")
        with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            file.write(prepared[key + "_sql"])
    print(json.dumps({"event": "native_planning_prepared", **prepared["counts"]}))


if __name__ == "__main__":
    main()
