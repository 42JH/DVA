"""가짜 고객: 모델 답 거르기(check) · 소리 내어 읽을 글(spoken). 실제 OpenAI는 부르지 않는다."""

from persona_check import customer

SCRIPT = ["택배 접수하려고요.", "010-2345-6789요.", "(무응답)"]


def test_check_turns_bad_answers_into_wait():
    assert customer.check({"action": "say", "index": 2}, SCRIPT)["text"] == "010-2345-6789요."
    assert customer.check({"action": "say", "index": 9}, SCRIPT)["action"] == "wait"       # 없는 번호
    assert customer.check({"action": "say", "index": True}, SCRIPT)["action"] == "wait"    # 참 · 거짓은 번호가 아니다
    assert customer.check({"action": "short", "short": "no"}, SCRIPT)["text"] == "아니요, 없어요"
    assert customer.check({"action": "short", "short": "maybe"}, SCRIPT)["action"] == "wait"
    assert customer.check({"action": "free", "text": "  멀티캠퍼스   1층 "}, SCRIPT)["text"] == "멀티캠퍼스 1층"
    assert customer.check({"action": "free", "text": " "}, SCRIPT)["action"] == "wait"       # 빈 말
    assert customer.check({"action": "end"}, SCRIPT)["action"] == "end"
    assert customer.check("글자", SCRIPT)["action"] == customer.check({"action": "dance"}, SCRIPT)["action"] == "wait"


def test_spoken_reads_numbers_in_korean():
    read = customer.spoken
    assert read("010-2345-6789요.") == "공일공 이삼사오 육칠팔구요."
    assert read("서울시 강남구 테헤란로 212, 멀티캠퍼스 1층이요.") == "서울시 강남구 테헤란로 이백십이, 멀티캠퍼스 일 층이요."
    assert read("부산광역시 해운대구 센텀중앙로 79, 102동 1503호요.") == "부산광역시 해운대구 센텀중앙로 칠십구, 백이 동 천오백삼 호요."
    assert read("102동 1503호") == "백이 동 천오백삼 호"
    assert read("5만 원 정도요.") == "오만 원 정도요." and read("100만 원이요.") == "백만 원이요."
    assert read("인동 9길 7-3") == "인동 구 길 칠 다시 삼"
    assert read("택배 접수하려고요.") == "택배 접수하려고요."
    numbers = (10, 11, 110, 1000, 10000, 50000, 12345, 200000000, 123456789)
    assert [customer.read_number(n) for n in numbers] == \
        ["십", "십일", "백십", "천", "만", "오만", "만이천삼백사십오", "이억", "일억이천삼백사십오만육천칠백팔십구"]


def test_choose_shows_the_customer_facts_and_what_was_said():
    text = customer.describe(SCRIPT, [("AI", "등록된 주소로 보내실까요?")], {1}, "등록 고객. 등록된 발송 주소: 서울 강남구 테헤란로 212")
    assert text.startswith("[고객 정보]\n등록 고객.") and "1. (말함) 택배 접수하려고요." in text and "AI: 등록된 주소로 보내실까요?" in text
    assert customer.describe(SCRIPT, [], set()).startswith("[대본]") and "(아직 대화 없음)" in customer.describe(SCRIPT, [], set())
