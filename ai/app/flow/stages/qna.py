"""§6 D QnA · 상담원 Hub. 어느 단계에서나(끝내는 단계 제외) 질문·제한된 요청으로 GLOBAL_INTENT에 들어오고,
들어오기 전 업무 단계를 기억했다가 RESUME_TASK로 돌아간다(고정 엣지 없이, §2.3).
검색은 백엔드 모델이 search_manual로 하고 그 결과(rag.found·rag.none·rag.failed)가 RAG의 Yes/No다. 검색 결과가
서버의 질문 판별보다 먼저 오면 그 결과로 바로 QnA에 들어간다(같은 질문을 두 번 처리하지 않게, app/listener.py)."""

import time
from datetime import datetime, timedelta, timezone

from app.flow.engine import ENTERED, RETURN, Stage, Transition
from app.flow.stages._common import COMMON_TOOLS, count_fail_offer, reset_fail

KST = timezone(timedelta(hours=9))
RAG_EVENTS = ("rag.found", "rag.none", "rag.failed")
OTHER_TASK = {"other_task": "다른 업무를 하겠다·더 궁금한 것이 없다"}


async def other_task(ctx, answer: str) -> list[str]:
    return ["agent.yes"] if answer == "yes" else ["qna.done"]


def offer(normal: str, third: str):
    return lambda ctx: third if ctx.agent_offered else normal


def agent_available(ctx) -> bool:
    """TODO(flow): 상담원 연결 가능 여부를 알려 줄 PBX·백엔드 정보가 없어 설정한 상담 시간(한국 시간)으로만 본다."""
    hour = datetime.now(KST).hour
    return ctx.cfg.flow.agent_open_hour <= hour < ctx.cfg.flow.agent_close_hour


def wait_rag(ctx, prev: str) -> None:
    ctx.rag_deadline = time.monotonic() + ctx.cfg.flow.rag_wait_sec  # 넘으면 rag.timeout(app/sideband.py watch_flow)


def entered_by_search(ctx) -> None:
    """검색 결과가 서버의 질문 판별보다 먼저 와서 QnA로 들어옴: 그 전에 시작한 고객 말의 질문 판별은 같은 질문이다."""
    ctx.search_entry_at = time.monotonic()


STAGES = [
    Stage(
        name="GLOBAL_INTENT",
        description="전역 의도 감지(진행 중 업무·단계를 저장)",
        subflow=True,  # 들어올 때 업무·단계를 resume에 저장한다(이미 QnA·상담원 흐름 안이면 덮어쓰지 않음)
        enter_on=("intent.question", "intent.restricted", *RAG_EVENTS),
        transitions=(Transition("intent.question", "QNA", forward=True),)
        + tuple(Transition(e, "QNA", forward=True, action=entered_by_search) for e in RAG_EVENTS)
        + (Transition("intent.restricted", "RESTRICTED_REQUEST"),),
    ),
    Stage(
        name="QNA",
        description="질문 받기",
        subflow=True,
        transitions=(Transition("intent.question", "RAG", say="D0"),)
        + tuple(Transition(e, "RAG", forward=True) for e in RAG_EVENTS),  # 검색이 이미 끝났으면 기다리지 않는다
    ),
    Stage(
        name="RAG",
        description="매뉴얼 검색 결과 기다리는 중",
        tools=COMMON_TOOLS,
        ask="RAG_WAIT",
        listen=False,  # 검색 중 고객 말은 쌓았다가 이 단계가 끝난 뒤 전역 의도로만 판별(§2.5(6))
        subflow=True,
        on_enter=wait_rag,
        transitions=(Transition("rag.found", "RAG_LLM_ANSWER", action=reset_fail),)
        + tuple(Transition(e, "D_AGENT_OFFER", say=offer("D5", "D5_3"), asks=True, action=count_fail_offer)
                for e in ("rag.none", "rag.failed", "rag.timeout")),
    ),
    Stage(name="RAG_LLM_ANSWER", description="검색 근거로 답하기", subflow=True,
          transitions=(Transition(ENTERED, "D_AFTER_ANSWER", say="RAG_ANSWER"),)),
    Stage(
        name="D_AFTER_ANSWER",
        description="답변 뒤 추가 질문·다른 업무",
        tools=COMMON_TOOLS,
        ask="D2",
        choices=lambda ctx: OTHER_TASK,  # 추가 질문은 GLOBAL_INTENT가 QNA로(D3)
        on_answer=other_task,
        subflow=True,
        transitions=(Transition("qna.done", "RESUME_TASK"),),
    ),
    Stage(
        name="RESTRICTED_REQUEST",
        description="제한된 요청",
        subflow=True,
        transitions=(Transition(ENTERED, "D_AGENT_OFFER", say=offer("D6", "D6_3"), asks=True,
                                action=count_fail_offer),),
    ),
    Stage(
        name="D_AGENT_OFFER",
        description="다른 업무·질문 또는 상담원 연결 제안",
        tools=COMMON_TOOLS,
        # "예"는 직전 안내에 상담원 제안이 있었을 때만 선택지다(D9). 다른 질문은 GLOBAL_INTENT가 QNA로(D8)
        choices=lambda ctx: ({"yes": "상담원 연결을 원한다"} if ctx.agent_offered else {}) | OTHER_TASK,
        on_answer=other_task,
        subflow=True,
        transitions=(
            Transition("agent.yes", "D_AGENT_AVAILABLE", lambda ctx: ctx.agent_offered, say="D9"),
            Transition("qna.done", "RESUME_TASK",
                       say=lambda ctx: "D7" if (ctx.flow.resume or {}).get("task") else None),
        ),
    ),
    Stage(
        name="D_AGENT_AVAILABLE",
        description="상담원 연결 가능 확인",
        subflow=True,
        transitions=(Transition(ENTERED, "AGENT_HANDOFF", agent_available),
                     Transition(ENTERED, "D_AFTER_NO_AGENT", say="D11", asks=True)),
    ),
    Stage(
        name="AGENT_HANDOFF",
        description="상담원 이관",
        listen=False,
        final=True,  # 그래프 종료: 안내가 끝나면 서버가 refer(app/sideband.py watch_end)
        ask=lambda ctx: "REFER_FAILED" if ctx.refer_failed else None,
        on_enter=lambda ctx, prev: ctx.request_refer(),
    ),
    Stage(
        name="D_AFTER_NO_AGENT",
        description="상담원 연결 불가 뒤 추가 질문·다른 업무",
        tools=COMMON_TOOLS,
        ask="D11",
        choices=lambda ctx: OTHER_TASK,  # 추가 질문은 GLOBAL_INTENT가 QNA로(D12)
        on_answer=other_task,
        subflow=True,
        transitions=(Transition("qna.done", "RESUME_TASK"),),
    ),
    Stage(name="RESUME_TASK", description="기존 업무 복귀(진입 직전 단계로)", subflow=True,
          transitions=(Transition(ENTERED, RETURN),)),
]
