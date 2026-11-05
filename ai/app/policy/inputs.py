"""Live 안내와 기록 경계가 공유하는 입력 규칙. 외부 BE 계약은 변경하지 않는다."""
import tomllib
from functools import lru_cache

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import ROOT


class InputRules(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    item_price_min: int = Field(gt=0)
    item_price_max: int = Field(gt=0)
    box_total_max: int = Field(gt=0)
    document_max: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_range(self):
        if self.item_price_min > self.item_price_max:
            raise ValueError("물품 가액 하한이 상한보다 큽니다")
        return self


@lru_cache(maxsize=1)
def input_rules() -> InputRules:
    with (ROOT / "policy" / "input_rules.toml").open("rb") as source:
        return InputRules.model_validate(tomllib.load(source))


def render_input_rules(policy) -> str:
    r = input_rules()
    upper = r.item_price_max + 1
    upper_text = f"{upper // 100_000_000}억 원" if upper % 100_000_000 == 0 else f"{upper:,}원"
    return "\n".join([
        "## Live가 먼저 판단하는 입력 규칙",
        f"- 물품 가액은 원 단위 정수 {r.item_price_min:,}원 이상 {upper_text} 미만만 받습니다. "
        "고객에게도 이처럼 짧은 상한의 '미만' 표현으로 안내하고, 최대 허용 정수를 길게 읽지 않습니다. "
        "범위 밖이거나 단위가 불명확한 금액은 기록을 맡기지 않고 바로 설명하고 다시 묻습니다.",
        f"- 받는 곳별 택배 내역마다 소형·중형·대형 박스 개수 합계는 {r.box_total_max}개 이하, "
        f"서류는 별도로 {r.document_max}개 이하입니다. 통화 전체 합계 제한이 아닙니다.",
        "- 정정은 해당 내역의 최종 전체 구성으로 판단합니다. 한도를 피하려고 같은 물품을 자동 분할하지 않습니다.",
        "- 서류인지 박스인지, 박스 크기·개수가 불명확하면 바로 필요한 부분만 묻습니다. 없는 규격은 0개입니다.",
        "- 전화번호는 들은 숫자를 빠뜨리거나 추측하지 않습니다. 010은 11자리, 그 밖의 0으로 시작하는 번호는 "
        "9~11자리, 15/16/18로 시작하는 대표번호는 8자리입니다. +82는 앞의 0으로 바꿉니다. 부족하면 바로 다시 묻습니다.",
        f"- 수거는 한국 시간 {policy.pickup.open}~{policy.pickup.close}, 현재부터 최소 "
        f"{policy.pickup.min_lead_minutes}분 이후, 오늘 날짜부터 {policy.pickup.max_days_ahead}일 뒤까지입니다. "
        "상대 시각은 최신 서버 시각을 사용하고 실제 계산 결과로 안내합니다.",
        "- 주소는 기본주소와 동·호수 등 상세주소를 구분해 맡깁니다. 주소 조회가 성공하고 필요한 주소 정보가 "
        "갖춰질 때까지 다음 항목 질문이나 다른 작업을 시작하지 않습니다. 실패·장애를 주소 확인 성공으로 취급하지 않습니다.",
    ])
