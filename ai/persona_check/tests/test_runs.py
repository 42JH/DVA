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


def test_default_is_all_core_is_the_core_set_and_the_limit_spans_runs(tmp_path, monkeypatch):
    monkeypatch.delenv("QDRANT_URL", raising=False)

    async def go():
        runs, seen = fake_runs(tmp_path, max_concurrency=2)
        with pytest.raises(ValueError):
            runs.start(server.RunRequest(scenarios=["없는것"]))
        run = runs.start(server.RunRequest(concurrency=2))
        core = runs.start(server.RunRequest(core=True, concurrency=2))
        await finish(runs)
        return run, core, seen

    run, core, seen = asyncio.run(go())
    usable = [s for s in judge.load_scenarios() if s.get("needs") != "faq"]            # 이 환경에는 FAQ 검색 서버가 없다
    assert run["total"] == len(usable) < len(judge.load_scenarios()) and run["candidate"] is False
    assert [i["scenario"] for i in core["items"]] == [s["id"] for s in usable if s.get("core")]
    assert seen["peak"] == 2                                                     # 묶음이 둘이어도 동시 통화는 전체 한도까지


def test_faq_scenario_runs_only_where_the_search_server_is_connected(tmp_path, monkeypatch):
    async def go():
        runs, _ = fake_runs(tmp_path)
        with pytest.raises(ValueError, match="FAQ"):
            runs.start(server.RunRequest(scenarios=["G1"]))                       # 검색 서버가 없으면 걸지 않는다
        monkeypatch.setenv("QDRANT_URL", "http://qdrant:6333")
        run = runs.start(server.RunRequest(core=True))
        await finish(runs)
        return run

    monkeypatch.delenv("QDRANT_URL", raising=False)
    assert "G1" in [i["scenario"] for i in asyncio.run(go())["items"]]


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
    monkeypatch.delenv("QDRANT_URL", raising=False)

    async def go():
        runs, _ = fake_runs(tmp_path)
        transport = httpx.ASGITransport(app=server.create_app(runs))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            assert (await http.get("/scenarios")).status_code == 503          # 토큰 미설정이면 닫힘
            monkeypatch.setenv("PERSONA_CHECK_TOKEN", TOKEN)
            assert (await http.get("/scenarios")).status_code == 401
            assert (await http.get("/scenarios", headers={"Authorization": "Bearer " + "틀림".encode().hex()})).status_code == 401
            listed = (await http.get("/scenarios", headers=AUTH)).json()
            assert {"id": "A1", "name": "신규 고객 기본 접수", "group": "접수", "core": True, "available": True} in listed
            assert next(s for s in listed if s["id"] == "G1")["available"] is False   # FAQ 검색 서버가 없는 환경
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


def test_runs_carry_a_tag_and_are_listed_newest_first_by_it(tmp_path, monkeypatch):
    monkeypatch.delenv("QDRANT_URL", raising=False)
    monkeypatch.setenv("PERSONA_CHECK_TOKEN", TOKEN)

    async def go():
        runs, _ = fake_runs(tmp_path)
        transport = httpx.ASGITransport(app=server.create_app(runs))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            ids = []
            for body in ({"scenarios": ["A1"], "tag": "1:7"}, {"scenarios": ["H9"], "tag": "1:6"},
                         {"scenarios": ["B3"], "tag": "1:7"}, {"scenarios": ["E1"]}):
                made = await http.post("/runs", json=body, headers=AUTH)
                assert made.status_code == 202
                ids.append(made.json()["runId"])
                await finish(runs)
                await asyncio.sleep(0.005)                                        # createdAt(밀리초)이 겹치지 않게
            assert (await http.get("/runs")).status_code == 401                    # 목록도 토큰이 있어야 한다
            everything = (await http.get("/runs", headers=AUTH)).json()
            assert [r["runId"] for r in everything] == ids[::-1]                   # 최신순
            assert [r["tag"] for r in everything] == [None, "1:7", "1:6", "1:7"]   # 안 붙이면 None
            mine = (await http.get("/runs", params={"tag": "1:7"}, headers=AUTH)).json()
            assert [r["runId"] for r in mine] == [ids[2], ids[0]]
            assert mine[0]["status"] == "done" and mine[0]["items"][0]["scenario"] == "B3"   # 묶음 상태와 같은 모양
            assert (await http.get("/runs", params={"tag": "없는표시"}, headers=AUTH)).json() == []
            assert (await http.post("/runs", json={"scenarios": ["A1"], "tag": "가" * 65}, headers=AUTH)).status_code == 422
        return ids

    ids = asyncio.run(go())
    # 다시 띄운 뒤에도 목록에 남고, 돌던 중에 꺼진 묶음은 '중단'으로 보인다
    stale = json.loads((tmp_path / ids[0] / "run.json").read_text("utf-8")) | {"status": "running"}
    (tmp_path / ids[0] / "run.json").write_text(json.dumps(stale, ensure_ascii=False), "utf-8")
    again = server.Runs(run_one=None, root=tmp_path)
    assert [(r["runId"], r["status"]) for r in again.recent("1:7")] == [(ids[2], "done"), (ids[0], "interrupted")]
    assert server.Runs(run_one=None, root=tmp_path / "아직없는폴더").recent() == []


def test_a_scenario_shows_its_script_and_the_answers_the_judge_will_use(tmp_path, monkeypatch):
    monkeypatch.delenv("QDRANT_URL", raising=False)
    monkeypatch.setenv("PERSONA_CHECK_TOKEN", TOKEN)

    async def go():
        runs, _ = fake_runs(tmp_path)
        transport = httpx.ASGITransport(app=server.create_app(runs))
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
            assert (await http.get("/scenarios/A1")).status_code == 401
            assert (await http.get("/scenarios/없는것", headers=AUTH)).status_code == 404
            return {i: (await http.get(f"/scenarios/{i}", headers=AUTH)).json() for i in ("A1", "E1", "F1", "G1")}

    got = asyncio.run(go())
    a1, source = got["A1"], judge.load_scenario("A1")
    assert (a1["id"], a1["name"], a1["group"], a1["core"], a1["available"]) == ("A1", "신규 고객 기본 접수", "접수", True, True)
    assert a1["caller"] == "신규 고객" and got["E1"]["caller"].startswith("등록 고객 ")
    assert [line["text"] for line in a1["lines"]] == [line["text"] for line in source["lines"]]
    assert a1["lines"][0]["optional"] is False and a1["lines"][-1]["optional"] is True
    assert a1["checks"] == source["checks"]
    names = [e["name"] for e in a1["expected"]]
    assert "대본 진행" not in names and names[:2] == ["접수된 택배 수", "접수 확인된 초안 수"]
    assert {"name": "받는 분 이름", "value": source["expect"]["parcel"]["receiver_name"]} in a1["expected"]
    assert {"name": "보내는 분 번호", "value": source["caller"]} in a1["expected"]   # 정답에 안 적으면 발신번호
    assert {"name": "조회 실행", "value": "1회 이상"} in got["E1"]["expected"]
    assert next(e for e in got["F1"]["expected"] if e["name"] == "기존 주문 상태")["value"][source_cancel()] == "CANCELLED"
    assert got["G1"]["available"] is False                                       # FAQ 검색 서버가 없는 환경


def source_cancel() -> str:
    """F1이 취소하기로 한 받는 분."""
    return judge.load_scenario("F1")["expect"]["receiver"]
