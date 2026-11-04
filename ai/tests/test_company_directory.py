"""기업·사원 배송지 검색의 가짜 백엔드 회귀 검증."""
import asyncio
import json

import httpx2
import pytest
from conftest import CALLER, GEO, FakeBackend, make_call, run
from test_backend_api import PIN, REGISTERED, api, context
from test_flow import ORIGIN

from app.backend_api import BackendError, CompanyDirectoryPage, parcel_body
from app.dispatcher import dispatch
from app.flow import engine
from app.flow.stages.order import order_answer
from app.order import CompanyPlace
from app.tools._base import ToolError


def company(name="주소셋", organization="주소기업", seq=26, **updates):
    return CompanyPlace(name=name, phone="01098765432", address="서울 중구 세종대로 110", address_detail="",
                        geo=GEO, organization_seq=6, organization_name=organization, membership_seq=seq,
                        customer_seq=seq, department_seq=None, department_name=None).model_copy(update=updates)


def entry():
    return {"organizationSeq": 6, "organizationName": "주소기업", "membershipSeq": 26, "customerSeq": 26,
            "departmentSeq": None, "departmentName": None, "addressData": {**PIN, "name": "주소셋"}}


def ready(db=None):
    db = db or FakeBackend()
    db.add_customer(CALLER, "현재이름", default_origin=ORIGIN)
    call = make_call(db)
    run(order_answer(call, "yes"))
    return call


def match(call, **args):
    return run(dispatch(call, "match_pins", json.dumps(args, ensure_ascii=False), f"match_{len(call.tool_calls)}"))








def test_company_http_new_contract_encoding_and_no_pin_reference():
    client, seen = api(lambda req: httpx2.Response(200, json={"data": [entry()], "hasNext": False, "total_count": 1}))
    page = run(client.search_company_places("주소기업 주소셋 &%", limit=5, offset=0))
    assert seen[0].url.path == "/api/companies/search"
    assert seen[0].url.params["q"] == "주소기업 주소셋 &%"
    assert "call_session_seq" not in seen[0].headers
    assert page.places[0].membership_seq == 26 and page.places[0].name == "주소셋"


@pytest.mark.parametrize("payload", [
    {"data": [], "hasNext": False},
    {"data": [], "hasNext": "false", "total_count": 0},
    {"data": [], "hasNext": True, "total_count": 2},
    {"data": [entry()], "hasNext": False, "total_count": 0},
    {"data": [{**entry(), "membershipSeq": True}], "hasNext": False, "total_count": 1},
    {"data": [{**entry(), "addressData": {}}], "hasNext": False, "total_count": 1},
])
def test_bad_company_response_is_failure_not_empty(payload):
    client, _ = api(lambda req: httpx2.Response(200, json=payload))
    with pytest.raises(BackendError, match="응답 형식"):
        run(client.search_company_places("주소기업"))


def test_other_company_employee_copies_all_address_values_without_asking_phone():
    call = ready()
    place = company()
    call.backend.company_places = [place]
    result = match(call, organization="주소기업", name="주소셋")
    assert result["ok"] and result["found"] == 1
    assert "주소기업" in engine.next_text(call)
    run(order_answer(call, "yes"))
    assert call.order.receiver_name == place.name and call.order.receiver_phone == place.phone
    assert call.order.receiver_address_detail == "" and call.order.receiver_geo == GEO
    assert "receiver_phone" not in engine.summary(call)["missing"]
    body = parcel_body(call.order)
    assert body["destination"]["name"] == place.name and body["destination"]["phoneNumber"] == place.phone
    assert "originPin" not in body and "membershipSeq" not in body["destination"]


def test_personal_pin_zero_does_not_skip_company_search():
    call = ready()
    call.backend.company_places = [company()]
    assert match(call, name="주소셋")["found"] == 1


def test_correction_clears_previous_name_company_detail_candidates_and_recipient():
    call = ready()
    call.backend.company_places = [company(name="다른이름", organization="첫회사", seq=1), company()]
    assert match(call, organization="첫회사", name="다른이름")["found"] == 1
    # 아직 후보를 확인하기 전 정정해도 이전 이름·기업이 남지 않아야 한다.
    assert match(call, organization="주소기업", name="주소셋", restart=True)["found"] == 1
    assert call.directory_terms == {"organization": "주소기업", "name": "주소셋"}
    run(order_answer(call, "yes"))
    assert call.order.receiver_name == "주소셋"
    assert match(call, organization="첫회사", name="다른이름", restart=True)["found"] == 1
    assert call.order.receiver_phone is None and call.order.receiver_address is None


def test_multiple_candidates_keep_company_department_and_address_labels():
    call = ready()
    call.backend.company_places = [company(department_name="개발부"), company(seq=27, department_name="영업부")]
    result = match(call, organization="주소기업", name="주소셋")
    assert result["found"] == 2
    assert all("주소기업" in label and "주소셋" in label for label in call.pin_labels())
    assert "개발부" in call.pin_labels()[0] and "영업부" in call.pin_labels()[1]
    assert match(call, department="영업부")["found"] == 1
    assert call.pin_offer.department_name == "영업부"


def test_more_results_ask_to_narrow_instead_of_selecting_first_page():
    call = ready()
    call.backend.company_places = [company(seq=i + 1) for i in range(call.cfg.flow.max_pin_options + 2)]
    result = match(call, organization="주소기업")
    assert result["ok"] and call.directory_status == "more"
    assert call.pin_offer is None and call.pin_candidates == []
    assert "많아요" in engine.next_text(call)


@pytest.mark.parametrize("failure", ["http", "transport", "timeout"])
def test_search_outage_is_not_no_match_and_old_candidate_cannot_be_selected(failure):
    call = ready()
    call.backend.company_places = [company()]
    assert match(call, organization="주소기업")["found"] == 1

    async def fail(*args, **kwargs):
        if failure == "http":
            raise BackendError("503")
        if failure == "transport":
            raise httpx2.ConnectError("연결 실패")
        raise TimeoutError()

    call.backend.search_company_places = fail
    result = match(call, organization="다른기업", restart=True)
    assert result["ok"] is False and "장애" in result["error"]
    assert call.directory_status == "failed" and call.pin_offer is None and call.pin_candidates == []
    assert "어려워요" in engine.next_text(call)
    assert "receiver_phone" in engine.summary(call)["missing"]


def test_empty_company_result_has_no_outage_status():
    call = ready()
    result = match(call, organization="없는기업", name="없는사원", place="서울")
    assert result["ok"] and result["found"] == 0 and call.directory_status is None
    assert call.order.receiver_name == "없는사원"


def test_old_search_response_does_not_overwrite_new_search():
    call = ready()

    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(query, **kwargs):
            if "옛회사" in query:
                started.set()
                await release.wait()
                return CompanyDirectoryPage([company(name="옛사원")], False, 1)
            return CompanyDirectoryPage([company()], False, 1)

        call.backend.search_company_places = delayed
        old = asyncio.create_task(call.find_places("옛사원", None, None, "옛회사"))
        await started.wait()
        await call.find_places("주소셋", None, None, "주소기업", restart=True)
        release.set()
        with pytest.raises(ToolError, match="이전 검색"):
            await old
        assert call.pin_offer.name == "주소셋"

    run(scenario())


def test_company_http_logs_and_errors_do_not_include_search_query(caplog):
    caplog.set_level("INFO", logger="httpx2")
    client, _ = api(lambda req: httpx2.Response(503, json={"error": {"message": "sensitive"}}))
    with pytest.raises(BackendError) as error:
        run(client.search_company_places("민감기업 민감이름 01099999999"))
    assert "민감" not in str(error.value) and "01099999999" not in str(error.value)
    assert "/api/companies/search" not in caplog.text


def test_first_page_with_has_next_is_not_a_unique_candidate():
    call = ready()

    async def page(*args, **kwargs):
        return CompanyDirectoryPage([company()], True, 2)

    call.backend.search_company_places = page
    assert match(call, organization="주소기업")["found"] == 0
    assert call.directory_status == "more" and call.pin_offer is None


def test_company_http_transport_failure_is_sanitized():
    def fail(req):
        raise httpx2.ConnectError(str(req.url), request=req)

    client, _ = api(fail)
    with pytest.raises(BackendError, match="연결 실패") as error:
        run(client.search_company_places("민감검색어"))
    assert "민감검색어" not in str(error.value)


def test_old_search_does_not_apply_after_direct_recipient_correction_or_new_parcel():
    async def scenario(call, new_parcel):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(*args, **kwargs):
            started.set()
            await release.wait()
            return CompanyDirectoryPage([company()], False, 1)

        call.backend.search_company_places = delayed
        old = asyncio.create_task(call.find_places("주소셋", None, None, "주소기업"))
        await started.wait()
        if new_parcel:
            call.new_parcel()
        else:
            await dispatch(call, "record_order", json.dumps({"receiver_name": "직접고친이름"}), "direct")
        release.set()
        with pytest.raises(ToolError, match="이전 검색"):
            await old
        assert call.pin_offer is None
        assert call.order.receiver_name == (None if new_parcel else "직접고친이름")

    run(scenario(ready(), False))
    run(scenario(ready(), True))
