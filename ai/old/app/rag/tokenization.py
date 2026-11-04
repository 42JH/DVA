"""BM25 비교 실험용 한국어 전처리. 서버의 검색 경로에는 아직 연결하지 않는다."""

from functools import lru_cache


# 모든 명사를 합치지 않고, 업무에서 한 단위로 쓰는 용어만 추가한다.
USER_WORDS = (
    "착불", "선결제", "소박스", "중박스", "대박스",
    "접수완료", "결제완료", "수령완료", "위탁대기", "발송완료", "취소중", "취소완료",
)
EXCLUDED_TAGS = {"SF", "SP", "SS", "SSO", "SSC", "SE", "SO", "VCP", "XSA", "XSV"}


@lru_cache(maxsize=2)
def get_kiwi(use_user_dictionary: bool = True):
    """기본/용어 보완 모델을 각각 한 번만 만든다."""
    from kiwipiepy import Kiwi

    kiwi = Kiwi(num_workers=1)
    if use_user_dictionary:
        for word in USER_WORDS:
            kiwi.add_user_word(word, tag="NNG")
    return kiwi


def tokenize_for_bm25(text: str, *, use_user_dictionary: bool = True) -> list[str]:
    """조사·어미 등을 빼고 내용어, 부정 표현, 숫자·단위를 남긴다."""
    tokens = get_kiwi(use_user_dictionary).tokenize(text)
    return [
        token.form.lower()
        for token in tokens
        if not token.tag.startswith(("J", "E")) and token.tag not in EXCLUDED_TAGS
    ]
