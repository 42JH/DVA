"""시험 묶음 창구: 줄 세우기 · 동시 실행 수 · 진행 상황 · 인증 · 다시 띄운 뒤 조회 · 종료 때 정리. 통화는 걸지 않는다(가짜 run_one)."""

import asyncio
import json

import httpx
import pytest

from persona_check import judge, server

TOKEN = "시험용-토큰".encode().hex()
AUTH = {"Authorization": f"Bearer {TOKEN}"}
PROMPT = "# 페르소나\n후보"


def fake_runs(tmp_path, max_concurrency=2, fail=(), seconds=0.05):
    seen = {"now": 0, "peak": 0, "personas": [], "cancelled": 0}

    async def run_one(scenario, persona, folder):
        seen["now"] += 1
        seen["peak"] = max(seen["peak"], seen["now"])
        seen["personas"].append(persona)
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            seen["cancelled"] += 1          # 실제 실행기는 여기서 음성 세션을 끊고 나온다
            raise
        finally:
            seen["now"] -= 1
        if scenario in fail:
            raise RuntimeError("통화가 연결되지 않음: connection_InvalidStatus")
        folder.mkdir(parents=True, exist_ok=True)
        verdict = {"scenario": scenario, "passed": scenario != "H9", "summary": "통과 2 · 실패 0 · 제외 0", "checks": [],
                   "liveSeconds": 12.0}
        (folder / "verdict.json").write_text(json.dumps(verdict, ensure_ascii=False), "utf-8")
        (folder / "backend.json").write_text(json.dumps({"scenario": scenario, "customer": {"lines": [[1.0, "AI", "안녕하세요."]]}}), "utf-8")
        return verdict

    return server.Runs(run_one=run_one, root=tmp_path, max_concurrency=max_concurrency), seen


async def finish(runs):
    await asyncio.gather(*runs.tasks)


def test_run_queues_scenarios_within_the_concurrency_limit_and_reports_each(tmp_path):
    async def go():
        runs, seen = fake_runs(tmp_path, max_concurrency=2, fail=("A4",))
        run = runs.start(server.RunRequest(scenarios=["A1", "A4", "B3", "H9"], promptText=PROMPT, concurrency=5))
        assert run["status"] == "running" and run["concurrency"] == 2 and [i["status"] for i in run["items"]] == ["queued"] * 4
        await finish(runs)
        return runs, seen, run["runId"]

    runs, seen, run_id = asyncio.run(go())
    run = runs.get(run_id)
    got = {i["scenario"]: (i["status"], i["passed"]) for i in run["items"]}
    assert run["status"] == "done" and run["finished"] == run["total"] == 4 and seen["peak"] == 2
    assert got == {"A1": ("done", True), "A4": ("error", None), "B3": ("done", True), "H9": ("done", False)}
    assert "connection_InvalidStatus" in next(i["error"] for i in run["items"] if i["scenario"] == "A4")
    assert run["items"][0]["liveSeconds"] == 12.0 and run["items"][0]["group"] == "접수"
    assert not runs.live                                                         # 끝난 묶음은 메모리에서 내리고 파일에서 읽는다
    assert seen["personas"][0] == {"promptText": PROMPT, "voiceId": None}
    assert (tmp_path / run_id / "persona.md").read_text("utf-8") == PROMPT
    # 다시 띄운 뒤에도 조회된다. 돌던 중에 꺼진 묶음은 '중단'으로 보인다
    again = server.Runs(run_one=None, root=tmp_path)
    assert again.get(run_id)["status"] == "done" and again.get("없는묶음") is None
    stale = json.loads((tmp_path / run_id / "run.json").read_text("utf-8")) | {"status": "running"}
    (tmp_path / run_id / "run.json").write_text(json.dumps(stale, ensure_ascii=False), "utf-8")
    assert again.get(run_id)["status"] == "interrupted"
    assert again.file(run_id, "A1", "verdict").name == "verdict.json"
    assert again.file(run_id, "A1", "audio") is None and again.file(run_id, "../..", "verdict") is None
    assert again.get("../" + run_id) is None and again.get(run_id + "/..") is None   # 묶음 번호 모양이 아니면 읽지 않는다


def test_default_is_all_core_is_the_core_set_and_the_limit_spans_runs(tmp_path):
    async def go():
        runs, seen = fake_runs(tmp_path, max_concurrency=2)
        with pytest.raises(ValueError):
            runs.start(server.RunRequest(scenarios=["없는것"]))
        run = runs.start(server.RunRequest(concurrency=2))
        core = runs.start(server.RunRequest(core=True, concurrency=2))
        await finish(runs)
        return run, core, seen

    run, core, seen = asyncio.run(go())
    assert run["total"] == len(judge.load_scenarios()) and run["candidate"] is False
    assert [i["scenario"] for i in core["items"]] == [s["id"] for s in judge.load_scenarios() if s.get("core")]
    assert seen["peak"] == 2                                                     # 묶음이 둘이어도 동시 통화는 전체 한도까지


def test_stop_cancels_running_calls_and_leaves_the_run_interrupted(tmp_path):
    async def go():
        runs, seen = fake_runs(tmp_path, max_concurrency=2, seconds=30)
        run = runs.start(server.RunRequest(scenarios=["A1", "B3", "E1"]))
        await asyncio.sleep(0.05)
        await runs.stop()
        return runs, seen, run["runId"]

    runs, seen, run_id = asyncio.run(go())
    assert seen["cancelled"] == 1 and seen["now"] == 0                           # 돌던 한 통(동시 1)이 취소되고 나머지는 시작하지 않는다
    assert runs.get(run_id)["status"] == "interrupted" and not runs.tasks


def test_http_needs_the_token_and_serves_status(tmp_path, monkeypatch):
    async def go():
        runs, _ = fake_runs(tmp_path)
        transport = httpx.ASGITransport(app=server.create_app(runs))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            assert (await http.get("/scenarios")).status_code == 503          # 토큰 미설정이면 닫힘
            monkeypatch.setenv("PERSONA_CHECK_TOKEN", TOKEN)
            assert (await http.get("/scenarios")).status_code == 401
            assert (await http.get("/scenarios", headers={"Authorization": "Bearer " + "틀림".encode().hex()})).status_code == 401
            listed = (await http.get("/scenarios", headers=AUTH)).json()
            assert {"id": "A1", "name": "신규 고객 기본 접수", "group": "접수", "core": True} in listed
            assert (await http.post("/runs", json={"scenarios": ["없는것"]}, headers=AUTH)).status_code == 422
            assert (await http.post("/runs", json={"promptText": "가" * 20001}, headers=AUTH)).status_code == 422
            made = await http.post("/runs", json={"scenarios": ["A1"]}, headers=AUTH)
            assert made.status_code == 202
            run_id = made.json()["runId"]
            await finish(runs)
            status = (await http.get(f"/runs/{run_id}", headers=AUTH)).json()
            assert status["status"] == "done" and status["items"][0]["passed"] is True
            assert (await http.get(f"/runs/{run_id}/A1/verdict", headers=AUTH)).json()["scenario"] == "A1"
            assert (await http.get(f"/runs/{run_id}/A1/record", headers=AUTH)).json()["customer"]["lines"][0][1] == "AI"
            assert (await http.get(f"/runs/{run_id}/A1/audio", headers=AUTH)).status_code == 404
            assert (await http.get("/runs/없는묶음", headers=AUTH)).status_code == 404

    asyncio.run(go())
