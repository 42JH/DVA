"""Studio 그래프(studio/graph.py)가 실제 흐름과 같은 경로를 보여 주는지: test_flow의 시나리오를 그대로 돌린다."""

import pytest
from conftest import run
from langgraph.checkpoint.memory import InMemorySaver
from test_flow import SCENARIOS

from studio import graph as studio

CUSTOMER = {fn: name for name, fn in studio.CUSTOMERS.items()}


def thread(tid):
    return studio.builder().compile(checkpointer=InMemorySaver()), {"configurable": {"thread_id": tid}}


@pytest.mark.parametrize("name, make_db, steps, expected_path, cfg", SCENARIOS, ids=[s[0] for s in SCENARIOS])
def test_studio_shows_same_path(name, make_db, steps, expected_path, cfg):
    async def play():
        g, conf = thread(f"scenario-{name}")
        view = await g.ainvoke({"customer": CUSTOMER[make_db]}, conf)
        if cfg is not None:
            studio.CALLS[f"scenario-{name}"].cfg = cfg  # 상담원 연결 가능 시간 등
        for kind, a, b, stage in steps:
            if kind == "tool":
                view = await g.ainvoke({"tool": a, "args": b}, conf)
            elif kind == "commit":
                view = await g.ainvoke({"commit": True}, conf)
            else:  # 전역 의도가 있으면 그것(답보다 먼저 본다, listener.apply_answer와 같은 순서)
                intent, slot = b
                view = await g.ainvoke({"intent": intent, "slot": slot} if intent != "none" else {"answer": a}, conf)
            assert view["stage"] == stage, f"{kind} {a} {b}"
        return view

    assert run(play())["path"] == expected_path


def test_studio_runs_each_stage_node_and_rejects_bad_input():
    async def play():
        g, conf = thread("nodes")
        view = await g.ainvoke({"customer": "new"}, conf)
        assert view["stage"] == "A_NEW_ORDER" and view["choices"] == ["order", "lookup"]
        assert (await g.ainvoke({"answer": "yes"}, conf))["result"]["error"]  # 이 단계엔 그 답이 없음
        assert (await g.ainvoke({"answer": "order", "tool": "get_state"}, conf))["result"]["error"]  # 하나만
        view = await g.ainvoke({"answer": "order"}, conf)
        view = await g.ainvoke({"tool": "record_order", "args": view["example_args"]}, conf)
        assert view["stage"] == "A_RECEIVER_HUB" and view["example_args"]
        view = await g.ainvoke({"tool": "record_order", "args": {**view["example_args"], "small_box_count": 1,
                                                                 "item_price": 1000, "pickup_at": None}}, conf)
        view = await g.ainvoke({"tool": "record_order", "args": view["example_args"]}, conf)
        assert view["stage"] == "A_CONFIRM" and not view["pending"]
        view = await g.ainvoke({"answer": "yes"}, conf)
        assert view["stage"] == "A_CONFIRM" and view["pending"]
        nodes = [list(u)[0] async for u in g.astream({"commit": True}, conf, stream_mode="updates")]
        return nodes

    # 사건 하나가 지나간 단계 노드가 Studio에 하나씩 보인다
    assert run(play()) == ["report", "A_CONFIRM", "A_PAYMENT", "A_DONE", "A_CHOICE", "done"]
