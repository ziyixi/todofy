import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareGoalsImport,
  goalImportStatements,
} from "../prepare-goals-import.ts";
import { startHarness } from "../../worker/test/runtime/harness.ts";

function fixture() {
  return {
    source_url: "https://notion.example/annual-plan",
    year: 2026,
    imported_at: "2026-10-24T12:00:00Z",
    objectives: [
      {
        key: "O1",
        title: "Synthetic annual direction",
        description: "Preserve 中文 and 'quotes'.",
        key_results: [
          {
            key: "KR1.1",
            title: "Synthetic result",
            kind: "outcome",
            target_text: "Publish a reproducible example",
            floor_text: "Keep useful notes",
          },
          {
            key: "KR1.2",
            title: "Synthetic routine",
            kind: "routine",
            floor_text: "A small regular action",
          },
        ],
      },
      {
        key: "O2",
        title: "Synthetic exploration",
        key_results: [
          {
            key: "KR2.1",
            title: "Optional interests",
            kind: "exploration",
            notes: "No numerical target.",
          },
        ],
      },
    ],
  };
}

test("imports only definitions into real D1; reruns preserve edits, progress and unrelated task state", async () => {
  const h = await startHarness();
  try {
    const task = await (
      await h.mutate(
        "POST",
        "/api/tasks/v1/tasks?request_id=761d710b-a872-4efa-a24b-f153451be79f",
        { title: "Existing synthetic task" },
      )
    ).json();
    const plan = prepareGoalsImport(fixture());
    for (const sql of goalImportStatements(plan)) await h.db.prepare(sql).run();
    const catalog = await (
      await h.fetch("/api/tasks/v1/goalCatalog?year=2026")
    ).json();
    assert.equal(catalog.objectives.length, 2);
    assert.equal(catalog.key_results.length, 3);
    const result = await (
      await h.fetch(`/api/tasks/v1/keyResults/${plan.keyResults[0].id}`)
    ).json();
    assert.equal(
      result.floor_text,
      fixture().objectives[0].key_results[0].floor_text,
    );
    assert.equal(
      result.target_text,
      fixture().objectives[0].key_results[0].target_text,
    );
    assert.equal(result.completed ?? false, false);
    assert.equal(result.focus_start_month ?? "", "");
    assert.deepEqual(result.milestones ?? [], []);
    const edit = await h.mutate(
      "PATCH",
      `/api/tasks/v1/keyResults/${plan.keyResults[0].id}?update_mask=notes&etag=${result.etag}&request_id=7f9c1a32-f681-411d-8e62-d00c6bcaa095`,
      { notes: "Owner added a real note" },
    );
    assert.equal(edit.status, 200);
    const progress = await h.mutate(
      "POST",
      "/api/tasks/v1/goalProgress?request_id=d1c5d41c-af29-4a41-aa72-748f44da2f84",
      { key_result_id: result.id, note: "A synthetic result was observed" },
    );
    assert.equal(progress.status, 200);
    const later = prepareGoalsImport({
      ...fixture(),
      imported_at: "2026-10-25T12:00:00Z",
    });
    assert.deepEqual(
      later.keyResults.map((row) => row.id),
      plan.keyResults.map((row) => row.id),
    );
    for (const sql of goalImportStatements(later))
      await h.db.prepare(sql).run();
    const preserved = await (
      await h.fetch(`/api/tasks/v1/keyResults/${result.id}`)
    ).json();
    assert.equal(preserved.notes, "Owner added a real note");
    const history = await (
      await h.fetch(`/api/tasks/v1/goalProgress?key_result_id=${result.id}`)
    ).json();
    assert.equal(history.goal_progress.length, 1);
    assert.deepEqual(
      await (await h.fetch(`/api/tasks/v1/tasks/${task.id}`)).json(),
      task,
    );
    const counts = await h.db
      .prepare(
        "SELECT (SELECT count(*) FROM objectives) AS objectives,(SELECT count(*) FROM key_results) AS key_results",
      )
      .first();
    assert.deepEqual(counts, { objectives: 2, key_results: 3 });
  } finally {
    await h.dispose();
  }
});

test("rejects invalid and duplicate source identities before producing SQL", () => {
  const duplicate = fixture();
  duplicate.objectives[1].key_results[0].key = "KR1.1";
  assert.throws(() => prepareGoalsImport(duplicate), /SOURCE_KEY_INVALID/);
  assert.throws(
    () => prepareGoalsImport({ ...fixture(), year: 2026.5 }),
    /YEAR_INVALID/,
  );
  assert.throws(() =>
    prepareGoalsImport({ ...fixture(), source_url: "javascript:alert(1)" }),
  );
  const wrongKind = fixture();
  wrongKind.objectives[0].key_results[0].kind = "invented";
  assert.throws(() => prepareGoalsImport(wrongKind));
  const sql = goalImportStatements(prepareGoalsImport(fixture()));
  assert(
    sql.every((statement) =>
      /^INSERT INTO (objectives|key_results)\(/.test(statement),
    ),
  );
  assert(
    sql.every((statement) => statement.endsWith("ON CONFLICT(id) DO NOTHING;")),
  );
  assert(!sql.join("\n").includes("'quotes'"));
});
