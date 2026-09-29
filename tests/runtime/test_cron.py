import tomllib

from tests.runtime.harness import ROOT, Worker


def test_cron_tick_wakes_the_coordinator(worker: Worker) -> None:
    [cron] = tomllib.loads((ROOT / "wrangler.toml").read_text())["triggers"]["crons"]
    before = worker.owner.get("/api/v1/spike/coordinator").json()["wakes"]

    assert worker.trigger_cron(cron).status_code == 200

    state = worker.owner.get("/api/v1/spike/coordinator").json()
    assert (state["wakes"], state["last_cron"]) == (before + 1, cron)
