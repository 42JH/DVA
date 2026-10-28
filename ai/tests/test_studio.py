"""Studio 그래프(studio/graph.py)가 실제 흐름과 같은 경로를 보여 주는지: test_flow의 시나리오를 그대로 돌린다."""

import pytest
from conftest import run
from langgraph.checkpoint.memory import InMemorySaver
from test_flow import SCENARIOS, new_db, saved_db

from studio import graph as studio

CUSTOMER = {new_db: "new", saved_db: "saved"}


def thread(tid):
    return studio.builder().compile(checkpointer=InMemorySaver()), {"configurable": {"thread_id": tid}}


@pytest.mark.parametrize("name, make_db, steps, expected_path", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_studio_shows_same_path(name, make_db, steps, expected_path):
    async def play():
        g, cfg = thread(f"scenario-{name}")
        view = await g.ainvoke({"customer": CUSTOMER[make_db]}, cfg)
        for kind, a, b, stage in steps:
            if kind == "tool":
                view = await g.ainvoke({"tool": a, "args": b}, cfg)
            else:  # 한 마디에 답과 용건이 같이 있으면 답 먼저, 용건 다음(listener.apply_answer와 같은 순서)
                if a != "none":
                    view = await g.ainvoke({"answer": a}, cfg)
                if b != "none":
                    view = await g.ainvoke({"intent": b}, cfg)
            assert view["stage"] == stage, f"{kind} {a} {b}"
        return view

    assert run(play())["path"] == expected_path


def test_studio_runs_each_stage_node_and_rejects_bad_input():
    async def play():
        g, cfg = thread("nodes")
        view = await g.ainvoke({"customer": "new"}, cfg)
        assert view["stage"] == "collecting" and "small_box_count" in view["example_args"]
        assert (await g.ainvoke({"answer": "confirm"}, cfg))["result"]["error"]  # collecting엔 그 답이 없음
        assert (await g.ainvoke({"answer": "x", "tool": "get_state"}, cfg))["result"]["error"]  # 하나만
        view = await g.ainvoke({"tool": "record_order", "args": view["example_args"]}, cfg)
        assert view["example_args"] == {} and "credit" in view["choices"]  # 결제 방식은 고객 답으로
        await g.ainvoke({"answer": "credit"}, cfg)
        await g.ainvoke({"answer": "confirm"}, cfg)
        nodes = [list(u)[0] async for u in g.astream({"answer": "no_more"}, cfg, stream_mode="updates")]
        return nodes

    # 사건 하나가 지나간 단계 노드가 Studio에 하나씩 보인다
    assert run(play()) == ["report", "after_order", "ending", "done"]
