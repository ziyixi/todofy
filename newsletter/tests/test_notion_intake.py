"""Offline frozen-artifact intake and durable journal, never Notion/model/mail.

Small SQLite tables hold public synthetic artifacts without booting a pipeline.
Existing Store tables and the real importer and journal run as-is.
"""

import json
import types

import pytest

import newsletter.contracts as contracts
import newsletter.notion_content as newsletter_notion_content
import newsletter.notion_intake as notion_intake
import newsletter.notion_journal as notion_journal
import newsletter.store as newsletter_store
import tests.support.notion_content as notion_content

BOOTSTRAP = "2026-09-07T12:00:00+00:00"
CURRENT = "2026-09-07T13:04:05.123456+00:00"
OLD = "2026-09-06T13:04:05.123456+00:00"
DESTINATION = {
    "materials": "synthetic-materials",
    "editions": "synthetic-editions",
    "private": False,
}


@pytest.fixture
def rig(tmp_path):
    store = newsletter_store.Store(tmp_path / "newsletter.sqlite3", "live")
    journal = notion_journal.NotionJournal(store, DESTINATION)
    journal.execute(
        "INSERT INTO metadata VALUES('notion_v2_bootstrap_at',?)", (BOOTSTRAP,)
    )
    store.db.executescript("""
        CREATE TABLE workflow_runs(
            id TEXT PRIMARY KEY, definition TEXT NOT NULL);
        CREATE TABLE workflow_artifacts(
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
            item_id TEXT NOT NULL, body TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT NOT NULL);
        CREATE TABLE publication_units(
            run_id TEXT NOT NULL, story_id TEXT NOT NULL, mode TEXT NOT NULL,
            issue_date TEXT NOT NULL, task TEXT NOT NULL, body TEXT NOT NULL,
            digest TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(run_id, story_id, mode, digest));
        CREATE TABLE collection_runs(
            id TEXT PRIMARY KEY, request_key TEXT NOT NULL);
        CREATE TABLE candidate_history(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    """)
    value = types.SimpleNamespace(
        store=store,
        journal=journal,
        intake=notion_intake.NotionIntake(journal, include_personal=False),
    )
    yield value
    store.close()


def add_run(rig, run_id="run-one", *, request_key=None):
    nodes = [
        {"id": "pool", "type": "deduplicate"},
        {"id": "discovery", "type": "discovery"},
        {"id": "feed", "type": "api_feed"},
        {"id": "research", "type": "story_brief"},
    ]
    rig.journal.execute(
        "INSERT OR IGNORE INTO workflow_runs VALUES(?,?)",
        (run_id, contracts.canonical_json({"nodes": nodes})),
    )
    rig.journal.execute(
        "INSERT OR IGNORE INTO collection_runs VALUES(?,?)",
        (run_id, request_key or "daily-" + notion_content.DAY),
    )


def add_artifact(
    rig,
    values,
    *,
    run_id="run-one",
    artifact_id="artifact-one",
    node="pool",
    item_id="",
    created_at=CURRENT,
):
    add_run(rig, run_id)
    body = {
        "candidates": values,
        "coverage": [{"note": "Synthetic pipeline context only"}],
    }
    rig.journal.execute(
        "INSERT INTO workflow_artifacts VALUES(?,?,?,?,?,?,?)",
        (
            artifact_id,
            run_id,
            node,
            item_id,
            contracts.canonical_json(body),
            contracts.content_hash(body),
            created_at,
        ),
    )


def add_edition(rig, value=None, *, run_id="run-one", snapshots=None):
    add_run(rig, run_id)
    value = (
        notion_content.edition(created_at=CURRENT, updated_at=CURRENT)
        if value is None
        else value
    )
    snapshots = [notion_content.packet()] if snapshots is None else snapshots
    rig.journal.execute(
        "INSERT INTO editions VALUES(?,?,?,?,?,?)",
        (
            value["id"],
            "collection:" + value["id"],
            contracts.content_hash(value),
            value["state"],
            contracts.canonical_json(value),
            contracts.canonical_json(snapshots),
        ),
    )
    rig.journal.execute(
        "INSERT INTO workflow_editions VALUES(?,?,?,?,?)",
        (
            value["id"],
            run_id,
            "{}",
            contracts.canonical_json(value["packet_ids"]),
            0,
        ),
    )
    return value


def add_research(
    rig, candidate_ids, *, run_id="run-one", evidence=None, created_at=CURRENT
):
    task = {"id": "story-one", "candidate_ids": candidate_ids}
    result = {
        "packets": [notion_content.packet()] if evidence is None else evidence
    }
    digest = contracts.content_hash({"task": task, "result": result})
    rig.journal.execute(
        "INSERT INTO publication_units VALUES(?,?,?,?,?,?,?,?)",
        (
            run_id,
            task["id"],
            "brief",
            notion_content.DAY,
            contracts.canonical_json(task),
            contracts.canonical_json(result),
            digest,
            created_at,
        ),
    )
    return digest


def entities(rig, kind="material"):
    return rig.journal.rows(
        "SELECT * FROM notion_entities WHERE kind=? ORDER BY key", (kind,)
    )


def candidate_row(rig, candidate_id="candidate-fixture", run_id="run-one"):
    return rig.journal.rows(
        "SELECT * FROM notion_candidates WHERE run_id=? AND candidate_id=?",
        (run_id, candidate_id),
    )[0]


def properties(entity):
    return json.loads(entity["properties"])


def prop_text(entity, field):
    prop = properties(entity)[field]
    return "".join(
        item["text"]["content"]
        for item in prop.get("rich_text", prop.get("title", []))
    )


def test_artifact_date_conversion_preserves_source_snapshot(
    rig,
):
    source = notion_content.candidate(published_at="2026-09-06T23:45:00Z")
    add_artifact(rig, [source])
    assert rig.intake.scan() > 0
    material = entities(rig)[0]
    assert properties(material)["first_seen"] == {
        "date": {"start": notion_content.DAY}
    }
    assert properties(material)["published_at"] == {
        "date": {"start": source["published_at"]}
    }
    saved = candidate_row(rig)
    assert saved["first_seen"] == CURRENT
    assert json.loads(saved["body"]) == source
    assert rig.journal.summary()["import_errors"] == []


def test_only_top_level_deduplicate_output_creates_one_entity_per_candidate(
    rig,
):
    first = notion_content.candidate(
        id="first",
        url="https://example.org/one",
        doi="10.1234/one",
        event_key="one",
    )
    second = notion_content.candidate(
        id="second",
        url="https://example.org/two",
        doi="10.1234/two",
        event_key="two",
    )
    decoy = notion_content.candidate(
        id="decoy",
        url="https://example.org/decoy",
        doi="10.1234/decoy",
        event_key="decoy",
    )
    add_artifact(rig, [decoy], node="discovery", artifact_id="raw-discovery")
    add_artifact(rig, [decoy], node="feed", artifact_id="raw-feed")
    add_artifact(
        rig,
        [decoy],
        node="pool",
        item_id="unexpected-map-item",
        artifact_id="map-item",
    )
    add_artifact(rig, [first, second], artifact_id="final-pool")
    rig.intake.scan()
    assert len(entities(rig)) == 2
    assert {
        row["candidate_id"]
        for row in rig.journal.rows("SELECT * FROM notion_candidates")
    } == {
        "first",
        "second",
    }
    assert {prop_text(value, "title") for value in entities(rig)} == {
        first["title"],
        second["title"],
    }
    assert all(
        "Synthetic pipeline context"
        not in json.dumps(rig.journal.versions(e["key"]))
        for e in entities(rig)
    )


def test_frozen_run_candidate_is_used_instead_of_mutable_candidate_history(rig):
    source = notion_content.candidate(
        authors="Frozen Synthetic Author", contribution="Frozen contribution"
    )
    mutated = {
        **source,
        "authors": "Later history author",
        "contribution": "Later history contribution",
    }
    rig.journal.execute(
        "INSERT INTO candidate_history VALUES(?,?)",
        (source["id"], contracts.canonical_json(mutated)),
    )
    add_artifact(rig, [source])
    rig.intake.scan()
    material = entities(rig)[0]
    assert prop_text(material, "authors") == source["authors"]
    assert prop_text(material, "value") == source["contribution"]
    assert json.loads(candidate_row(rig)["body"]) == source
    assert "Later history" not in json.dumps(
        rig.journal.versions(material["key"])
    )


def test_research_keeps_metadata_and_complete_public_packets(
    rig,
):
    source = notion_content.candidate(authors="", affiliations="")
    add_artifact(rig, [source])
    research = notion_content.packet()
    research["content"]["body"] = (
        "OTHER SOURCE AUTHOR is not the candidate author. " * 200
    )
    add_research(rig, [source["id"]], evidence=[research])
    rig.intake.scan()
    material = entities(rig)[0]
    assert (
        prop_text(material, "authors")
        == prop_text(material, "affiliations")
        == ""
    )
    assert properties(material)["progress"] == {"select": {"name": "已研究"}}
    versions = rig.journal.versions(material["key"])
    assert len(versions) == 2
    assert research["content"]["body"] in notion_content.block_text(
        json.loads(versions[-1]["blocks"])
    )
    assert rig.journal.summary()["import_errors"] == []


def matching_candidates():
    used_url = notion_content.packet()["content"]["sources"][0]["url"]
    return [
        notion_content.candidate(
            id="used", url=used_url, doi="", event_key="used-event"
        ),
        notion_content.candidate(
            id="selected-but-unused",
            url="https://example.org/not-cited",
            doi="",
            event_key="unused-event",
        ),
    ]


def edition_with_unused_selected_candidate():
    value = notion_content.edition(created_at=CURRENT, updated_at=CURRENT)
    value["publication"]["stories"][0].update(
        candidate_ids=["used", "selected-but-unused"], disposition="brief"
    )
    snapshots = [notion_content.packet()]
    snapshots[0]["content"]["sources"].append(
        {
            "id": "unused",
            "title": "Synthetic unreferenced source",
            "url": "https://example.org/not-cited",
            "excerpt": "Not cited by the final edition.",
            "access_scope": "full_text",
            "published_at": notion_content.DAY,
        }
    )
    return value, snapshots


def test_adopted_relations_follow_citations_not_selection(
    rig,
):
    add_artifact(rig, matching_candidates())
    value, snapshots = edition_with_unused_selected_candidate()
    add_edition(rig, value, snapshots=snapshots)
    rig.intake.scan()
    used = candidate_row(rig, "used")["entity_key"]
    unused = candidate_row(rig, "selected-but-unused")["entity_key"]
    assert rig.journal.rows("SELECT * FROM notion_links") == [
        {"edition_key": "edition:" + value["id"], "material_key": used}
    ]
    assert all(
        row["material_key"] != unused
        for row in rig.journal.rows("SELECT * FROM notion_links")
    )


def test_edition_before_candidates_repairs_relations_without_new_edition_body(
    rig,
):
    value, snapshots = edition_with_unused_selected_candidate()
    add_edition(rig, value, snapshots=snapshots)
    rig.intake.scan()
    key = "edition:" + value["id"]
    before = rig.journal.versions(key)
    assert rig.journal.rows("SELECT * FROM notion_links") == []
    add_artifact(rig, matching_candidates())
    rig.intake.scan()
    assert len(rig.journal.rows("SELECT * FROM notion_links")) == 1
    assert rig.journal.versions(key) == before
    assert rig.intake.scan() == 0


def test_delivery_refresh_does_not_append_an_edition_version(
    rig,
):
    value = add_edition(rig)
    rig.intake.scan()
    key = "edition:" + value["id"]
    before = rig.journal.versions(key)
    value.update(
        delivery_state="provider_accepted",
        provider_message_id="synthetic-provider-receipt",
        updated_at="2026-09-07T14:00:00Z",
    )
    rig.journal.execute(
        "UPDATE editions SET body=? WHERE id=?",
        (contracts.canonical_json(value), value["id"]),
    )
    assert rig.intake.scan() > 0
    assert rig.journal.versions(key) == before
    assert properties(rig.journal.entity(key))["delivery"] == {
        "select": {"name": "已提交"}
    }
    assert (
        len(
            rig.journal.rows(
                "SELECT * FROM notion_imports WHERE kind='edition'"
            )
        )
        == 1
    )
    assert rig.intake.scan() == 0


def test_old_history_marked_test_keeps_sqlite_or_creating_delivery(
    rig,
):
    add_artifact(rig, [notion_content.candidate()], created_at=OLD)
    value = notion_content.edition(created_at=OLD, updated_at=OLD)
    add_edition(rig, value)
    before = rig.journal.rows("SELECT body,snapshot FROM editions")
    rig.intake.scan()
    assert properties(entities(rig)[0])["fixture"] == {"checkbox": True}
    assert properties(entities(rig, "edition")[0])["edition_type"] == {
        "select": {"name": "测试"}
    }
    assert rig.journal.rows("SELECT body,snapshot FROM editions") == before
    assert rig.journal.rows("SELECT * FROM sends") == []
    assert rig.journal.rows("SELECT * FROM verification_sends") == []


def test_same_date_editions_keep_keys_and_mark_manual_as_test(
    rig,
):
    first = add_edition(rig)
    add_run(rig, "run-two", request_key="manual-preview-synthetic")
    second = add_edition(
        rig,
        notion_content.edition(
            id="second-edition", created_at=CURRENT, updated_at=CURRENT
        ),
        run_id="run-two",
    )
    rig.intake.scan()
    values = entities(rig, "edition")
    assert {value["key"] for value in values} == {
        "edition:" + first["id"],
        "edition:" + second["id"],
    }
    assert properties(rig.journal.entity("edition:" + first["id"]))[
        "edition_type"
    ] == {"select": {"name": "日常"}}
    assert properties(rig.journal.entity("edition:" + second["id"]))[
        "edition_type"
    ] == {"select": {"name": "测试"}}


def test_explicit_verification_receipt_labels_revision_not_another_daily(rig):
    value = add_edition(rig)
    rig.journal.execute(
        "INSERT INTO verification_sends VALUES(?,?,?,?,?,?)",
        (
            notion_content.DAY,
            value["id"],
            "synthetic-verification",
            "a" * 64,
            "prior-edition",
            CURRENT,
        ),
    )
    rig.intake.scan()
    assert properties(entities(rig, "edition")[0])["edition_type"] == {
        "select": {"name": "修订"}
    }


def test_different_dois_with_same_event_are_separate_materials(rig):
    first = notion_content.candidate(
        id="one",
        doi="10.1234/one",
        url="https://example.org/one",
        event_key="shared-conference",
    )
    second = notion_content.candidate(
        id="two",
        doi="10.1234/two",
        url="https://example.org/two",
        event_key="shared-conference",
    )
    add_artifact(rig, [first, second])
    rig.intake.scan()
    assert len(entities(rig)) == 2
    assert (
        candidate_row(rig, "one")["entity_key"]
        != candidate_row(rig, "two")["entity_key"]
    )
    assert rig.journal.summary()["import_errors"] == []


@pytest.mark.parametrize("bad_index", [0, 1])
def test_one_invalid_candidate_is_diagnosed_without_losing_other_candidates(
    rig, bad_index
):
    first = notion_content.candidate(
        id="valid-one",
        doi="10.1234/one",
        url="https://example.org/one",
        event_key="one",
    )
    second = notion_content.candidate(
        id="valid-two",
        doi="10.1234/two",
        url="https://example.org/two",
        event_key="two",
    )
    bad = notion_content.candidate(
        id="bad",
        doi="",
        url="not a valid public URL",
        event_key="bad",
        summary="bad",
    )
    values = [first, second]
    values.insert(bad_index, bad)
    add_artifact(rig, values)
    rig.intake.scan()
    assert {
        row["candidate_id"]
        for row in rig.journal.rows("SELECT * FROM notion_candidates")
    } == {
        "valid-one",
        "valid-two",
    }
    assert len(entities(rig)) == 2
    assert rig.journal.summary()["import_errors"]
    assert rig.intake.scan() == 0


def test_snapshot_conflict_precedes_projection_mutation(
    rig,
):
    original = notion_content.candidate()
    add_artifact(rig, [original])
    rig.intake.scan()
    before_entities = entities(rig)
    key = before_entities[0]["key"]
    before_versions = rig.journal.versions(key)
    changed = {
        **original,
        "summary": "This is a conflicting frozen artifact.",
        "authors": "Wrong replacement author",
    }
    add_artifact(rig, [changed], artifact_id="conflicting-pool")
    rig.intake.scan()
    assert entities(rig) == before_entities
    assert rig.journal.versions(key) == before_versions
    assert json.loads(candidate_row(rig)["body"]) == original
    assert rig.journal.summary()["import_errors"]


def test_two_run_snapshots_share_material_but_do_not_overwrite_the_old_run_body(
    rig,
):
    original = notion_content.candidate()
    add_artifact(rig, [original], created_at=OLD)
    rig.intake.scan()
    updated = {
        **original,
        "version": "v3",
        "summary": "A real new synthetic comparison is available.",
    }
    add_artifact(rig, [updated], run_id="run-two", artifact_id="second-pool")
    rig.intake.scan()
    assert len(entities(rig)) == 1
    assert json.loads(candidate_row(rig)["body"]) == original
    assert json.loads(candidate_row(rig, run_id="run-two")["body"]) == updated
    assert len(rig.journal.versions(entities(rig)[0]["key"])) == 2
    assert properties(entities(rig)[0])["first_seen"] == {
        "date": {"start": "2026-09-06"}
    }


def test_journal_property_only_update_invalid_frozen_edition_body_atomic(
    rig,
):
    journal = rig.journal
    first = newsletter_notion_content.edition_projection(
        notion_content.edition(), packets=[notion_content.packet()]
    )
    journal.enqueue("edition", first)
    accepted = newsletter_notion_content.edition_projection(
        notion_content.edition(delivery_state="provider_accepted"),
        packets=[notion_content.packet()],
    )
    journal.enqueue("edition", accepted)
    before = journal.entity(first.key)
    assert len(journal.versions(first.key)) == 1
    changed = notion_content.edition()
    changed["draft"]["introduction"] = "An altered frozen edition body."
    with pytest.raises(ValueError, match="frozen_edition_changed"):
        journal.enqueue(
            "edition",
            newsletter_notion_content.edition_projection(
                changed, packets=[notion_content.packet()]
            ),
        )
    assert journal.entity(first.key) == before
    assert len(journal.versions(first.key)) == 1


def test_journal_relations_resolve_only_after_both_pages_are_known(rig):
    material = notion_content.project_material()
    archived = newsletter_notion_content.edition_projection(
        notion_content.edition(), packets=[notion_content.packet()]
    )
    journal = rig.journal
    journal.enqueue("material", material)
    journal.enqueue("edition", archived)
    journal.execute(
        "INSERT INTO notion_links VALUES(?,?)", (archived.key, material.key)
    )
    assert journal.desired(journal.entity(archived.key))["material_ids"] == {
        "relation": []
    }
    journal.execute(
        "UPDATE notion_entities SET page_id='material-page' WHERE key=?",
        (material.key,),
    )
    journal.execute(
        "UPDATE notion_entities SET page_id='edition-page' WHERE key=?",
        (archived.key,),
    )
    assert journal.desired(journal.entity(archived.key))["material_ids"] == {
        "relation": [{"id": "material-page"}]
    }
    desired = journal.desired(journal.entity(material.key))
    assert desired["edition_ids"] == {"relation": [{"id": "edition-page"}]}
    assert desired["progress"] == {"select": {"name": "已刊出"}}


def test_journal_restart_keeps_unknown_mutations_and_never_resets_them_to_new(
    rig,
):
    journal = rig.journal
    value = notion_content.project_material()
    journal.enqueue("material", value)
    journal.execute(
        "UPDATE notion_entities SET create_state='creating' WHERE key=?",
        (value.key,),
    )
    journal.execute(
        "UPDATE notion_versions SET state='appending',pending_chunk='[]' "
        "WHERE entity_key=?",
        (value.key,),
    )
    reopened = notion_journal.NotionJournal(rig.store, DESTINATION)
    assert reopened.entity(value.key)["create_state"] == "unknown"
    assert reopened.versions(value.key)[0]["state"] == "unknown"
    assert (
        notion_journal.NotionJournal(rig.store, DESTINATION).entity(value.key)[
            "create_state"
        ]
        == "unknown"
    )


def test_destination_or_privacy_change_requires_migration(
    rig,
):
    value = notion_content.project_material()
    rig.journal.enqueue("material", value)
    before = entities(rig)
    with pytest.raises(ValueError, match="explicit migration"):
        notion_journal.NotionJournal(
            rig.store, {**DESTINATION, "private": True}
        )
    assert entities(rig) == before


def test_candidate_import_keeps_legacy_projection_receipts(
    rig,
):
    legacy = notion_content.packet()
    rig.journal.execute(
        "INSERT INTO packets(id,principal,request_key,digest,body,projection) "
        "VALUES(?,?,?,?,?,?)",
        (
            legacy["id"],
            "synthetic",
            "legacy-packet",
            contracts.content_hash(legacy),
            contracts.canonical_json(legacy),
            "unknown",
        ),
    )
    before = rig.journal.rows("SELECT * FROM packets")
    add_artifact(rig, [notion_content.candidate()])
    rig.intake.scan()
    assert rig.journal.rows("SELECT * FROM packets") == before
