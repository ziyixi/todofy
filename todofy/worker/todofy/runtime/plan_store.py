"""The Mail categories in the planning store's D1 tables (migrations/0007_plan_store.sql): plan_categories of scheme
'mail', with their Tasks label IDs in plan_settings 'todoist.mail' (a frozen key name). Planning itself is Tasks';
the store's other tables were dropped by migration 0013 (docs/planning-api.md).
"""

import json
from typing import Any

from todofy.core.mailbox import Category, MailSettings
from todofy.core.sql import plan as sql

# The Mail categories' Tasks labels (a frozen key name):
#   {"categories": [{"id": <plan_categories.id>, "label_id": "<Tasks label ID>", "label": "<its name when saved>"}],
#    "destination": "<a project ID saved before Tasks>"}
# Nothing reads the destination: Tasks' Mail conversion (runtime/plus_mail.py) creates an Inbox task, and an
# update keeps the saved value as it is.
MAIL_KEY = "todoist.mail"


def mail_settings_statements(db: Any) -> list[Any]:
    """The two reads of the Mailbox's settings, for a caller's batch (mail_settings_of reads their answers)."""
    return [db.prepare(sql.MAIL_CATEGORIES.sql), db.prepare(sql.SETTING.sql).bind(MAIL_KEY)]


async def mail_settings(db: Any) -> MailSettings:
    """The Mailbox's categories and destination, one batch."""
    return mail_settings_of(*await db.batch(mail_settings_statements(db)))


def mail_settings_of(rows: Any, document: Any) -> MailSettings:
    """The active category rows with their label binding, from the answers to mail_settings_statements."""
    saved = next((json.loads(dict(row)["value"]) for row in document.results), {"categories": [], "destination": ""})
    labels = {int(entry["id"]): entry for entry in saved["categories"]}
    categories = []
    for row in (dict(item) for item in rows.results):
        # A category is saved with its binding in one batch; a row without one is ignored.
        if (bound := labels.get(int(row["id"]))) is not None:
            categories.append(Category(int(row["id"]), bound["label_id"], bound["label"], int(row["priority"])))
    return MailSettings(tuple(categories), saved["destination"])


async def next_category_id(db: Any) -> int:
    row = await db.prepare(sql.NEXT_CATEGORY_ID.sql).first()
    return int(row["id"])


async def save_mail_settings(
    db: Any, current: MailSettings, saved: MailSettings, archived: list[int], now: int
) -> None:
    """Replaces the Mailbox's settings in one batch: the archived categories go first (so a name they free can be
    taken again), the kept ones take their new names and places, the new ones are added, and the binding follows."""
    kept = {category.id for category in current.categories}
    statements = [db.prepare(sql.ARCHIVE_CATEGORY.sql).bind(now, now, category_id) for category_id in archived]
    for position, category in enumerate(saved.categories):
        if category.id in kept:
            statement = db.prepare(sql.KEEP_CATEGORY.sql).bind(category.name, position, now, category.id)
        else:
            statement = db.prepare(sql.ADD_CATEGORY.sql).bind(
                category.id, category.name, category.priority, position, now, now
            )
        statements.append(statement)
    binding = {
        "categories": [
            {"id": category.id, "label_id": category.label_id, "label": category.label} for category in saved.categories
        ],
        "destination": saved.destination,
    }
    value = json.dumps(binding, ensure_ascii=False, separators=(",", ":"))
    statements.append(db.prepare(sql.SAVE_SETTING.sql).bind(MAIL_KEY, value, now))
    await db.batch(statements)
