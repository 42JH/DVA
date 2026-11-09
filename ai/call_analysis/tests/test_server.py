"""통화 불만 판정 서비스(server.py): 가짜 모델로 인증 · 입력 검사 · 응답 모양 · 실패 코드를 확인한다. 실제 OpenAI를 부르지 않는다."""

from fastapi.testclient import TestClient

from call_analysis import server
from test_call_analysis import CALL, FakeClient, reply  # 같은 폴더의 가짜 모델 · 통화 (pytest가 폴더를 경로에 넣음)

AUTH = {"Authorization": "Bearer test-token"}


def client_with(fake) -> TestClient:
    server.app.state.client = fake
    server.app.state.token = "test-token"
    return TestClient(server.app)


def test_needs_token():
    with client_with(FakeClient(reply())) as c:
        assert c.post("/analyze", json={"callSessionSeq": 1, "events": CALL}).status_code == 401
        bad = c.post("/analyze", json={"callSessionSeq": 1, "events": CALL}, headers={"Authorization": "Bearer x"})
        assert bad.status_code == 401
        assert c.get("/health").json() == {"ok": True}


def test_analyze_returns_backend_shape():
    with client_with(FakeClient(reply(issue4="FRUSTRATION"))) as c:
        r = c.post("/analyze", json={"callSessionSeq": 7, "events": CALL}, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"hasComplaint", "complaints", "repeatQuestionCount", "votes", "model", "tokens"}
    assert body["votes"] == 3 and isinstance(body["repeatQuestionCount"], int)
    assert body["tokens"]["input"] == 900 * 3  # 가짜 모델 한 판 900 × 3판
    assert body["complaints"]  # 차례 4(고객이 불평)의 불만 표현 — 앞 차례에 다른 문제가 없어 남음
    for c in body["complaints"]:
        assert set(c) == {"type", "evidenceText", "offsetSeconds", "utteranceOrders"}
        assert c["type"] in server.BACKEND_TYPE.values()  # 백엔드가 받는 유형 이름으로
    assert body["hasComplaint"] is True


def test_customer_confusion_is_not_counted():
    confused = reply(issue3="CUSTOMER_CONFUSION").replace('"complain"', '"other"')  # 불만 표현 없이 되물음만
    with client_with(FakeClient(confused)) as c:
        body = c.post("/analyze", json={"callSessionSeq": 8, "events": CALL}, headers=AUTH).json()
    assert body["complaints"] == [] and body["hasComplaint"] is False


def test_empty_call_is_no_complaint():
    with client_with(FakeClient(reply())) as c:
        r = c.post("/analyze", json={"callSessionSeq": 2, "events": []}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["hasComplaint"] is False and r.json()["votes"] == 0


def test_model_failure_is_503_and_bad_input_is_422():
    with client_with(FakeClient(TimeoutError())) as c:
        assert c.post("/analyze", json={"callSessionSeq": 3, "events": CALL}, headers=AUTH).status_code == 503
        wrong = c.post("/analyze", json={"callSessionSeq": 0, "events": CALL}, headers=AUTH)
        assert wrong.status_code == 422
