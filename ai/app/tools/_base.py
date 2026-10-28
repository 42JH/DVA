"""도구 공용 부품: 레지스트리, 결과·오류 형식, 전화번호 정규화(spec/tools.md)."""

import importlib
import pkgutil
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import openai
from pydantic import BaseModel, ConfigDict, Field

from app.order import PHONE_FIELDS


class Args(BaseModel):
    """모든 도구 인수의 기반: 모르는 키 거부, 타입 강제(모델이 만든 인수는 미신뢰 입력)."""

    model_config = ConfigDict(extra="forbid", strict=True)


class NoArgs(Args):
    pass


class OrderFields(Args):
    """주문 항목 인수(기록·수정 공용). 고객이 말한 항목만 채우고 나머지는 null."""

    sender_name: str | None = Field(None, max_length=30)
    sender_phone: str | None = Field(None, max_length=40, description="들은 그대로(한글 숫자 가능)")
    sender_address: str | None = Field(None, max_length=120, description="기본 주소(도로명·지번)")
    sender_address_detail: str | None = Field(None, max_length=60, description="동·호수 등. 없다고 하면 빈 문자열")
    receiver_name: str | None = Field(None, max_length=30)
    receiver_phone: str | None = Field(None, max_length=40, description="들은 그대로(한글 숫자 가능)")
    receiver_address: str | None = Field(None, max_length=120, description="기본 주소(도로명·지번)")
    receiver_address_detail: str | None = Field(None, max_length=60, description="동·호수 등. 없다고 하면 빈 문자열")
    document_count: int | None = Field(None, ge=0, le=99, description="서류 봉투 수")
    small_box_count: int | None = Field(None, ge=0, le=99, description="소형 박스 수")
    medium_box_count: int | None = Field(None, ge=0, le=99, description="중형 박스 수")
    big_box_count: int | None = Field(None, ge=0, le=99, description="대형 박스 수")
    other_item: str | None = Field(None, max_length=40, description="서류·박스가 아닌 물품일 때만 그 설명")
    item_price: int | None = Field(None, ge=0, le=100_000_000, description="물품 가액(원). 예: 만 원 → 10000")
    client_comment: str | None = Field(None, max_length=100, description="배송 요청 사항(고객이 말했을 때만)")
    pickup_at: str | None = Field(None, max_length=40, description="수거 희망 시각. 한국 시간 ISO 8601(예: 2026-10-29T14:00:00+09:00)")
    customer_name: str | None = Field(None, max_length=30, description="전화 주신 분 성함(물었을 때만)")

    def cleaned(self) -> tuple[dict, list[str]]:
        """(저장할 값, 형식이 틀린 항목). 전화번호는 숫자만 남기고, 수거 시각은 미래의 시간대 포함 시각만 받는다."""
        values, invalid = {}, []
        for name, value in self.model_dump(include=set(OrderFields.model_fields), exclude_none=True).items():
            if name in PHONE_FIELDS:
                value = normalize_phone(value)
            elif name == "pickup_at":
                value = future_time(value)
            elif isinstance(value, str):
                value = value.strip()
            if value is None:
                invalid.append(name)
                continue
            values[name] = value
        return values, invalid


@dataclass
class Result:
    data: dict = field(default_factory=dict)
    events: list[str] = field(default_factory=list)


class ToolError(Exception):
    """모델에 돌려줄 오류. events가 있으면 일부 반영된 것(예: 전화번호만 틀리고 나머지는 기록)."""

    def __init__(self, error: str, retry: str = "", events: list[str] | None = None):
        super().__init__(error)
        self.error, self.retry, self.events = error, retry, events or []


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[Args]
    run: Callable[[Any, Any], Awaitable[Result]]

    def spec(self) -> dict:
        """live.toml에 이름만 적은 함수 도구를 채우는 strict 함수 도구 정의."""
        fn = openai.pydantic_function_tool(self.args, name=self.name, description=self.description)["function"]
        return {"type": "function", "name": fn["name"], "description": fn["description"],
                "parameters": fn["parameters"], "strict": fn["strict"]}


TOOLS: dict[str, Tool] = {}


def tool(name: str, description: str, args: type[Args] = NoArgs):
    def register(fn):
        if name in TOOLS:
            raise RuntimeError(f"도구 이름 중복: {name}")
        TOOLS[name] = Tool(name, description, args, fn)
        return fn

    return register


def load_tools(package: str = "app.tools") -> dict[str, Tool]:
    """app/tools 안의 모듈을 모두 import해 등록한다."""
    pkg = importlib.import_module(package)
    for info in pkgutil.iter_modules(pkg.__path__):
        if not info.name.startswith("_"):
            importlib.import_module(f"{package}.{info.name}")
    return TOOLS


def require_confirmed(args: Any) -> None:
    if args.customer_confirmed is not True:
        raise ToolError("고객 확인 없음", "고객에게 확인을 받은 뒤 customer_confirmed=true로 다시 호출")


def require_caller(ctx: Any) -> str:
    if not ctx.caller:
        raise ToolError("발신번호를 알 수 없어 할 수 없음", "상담원 전환을 안내")
    return ctx.caller


KST = timezone(timedelta(hours=9))


def future_time(raw: str) -> str | None:
    """모델이 만든 시각(미신뢰): 시간대가 있고 지금보다 뒤여야 한다. 한국 시간 ISO 8601로 돌려준다."""
    try:
        at = datetime.fromisoformat(raw.strip())
    except ValueError:
        return None
    if at.tzinfo is None or at <= datetime.now(timezone.utc):
        return None
    return at.astimezone(KST).isoformat(timespec="seconds")


# --- 전화번호 ---

_KOREAN_DIGITS = {"공": "0", "영": "0", "빵": "0", "일": "1", "이": "2", "삼": "3", "사": "4",
                  "오": "5", "육": "6", "륙": "6", "칠": "7", "팔": "8", "구": "9"}


def normalize_phone(raw: str) -> str | None:
    """한글 숫자·기호를 숫자만으로 바꾸고 자릿수를 검사한다. 틀리면 None(저장하지 않는다)."""
    s = "".join(_KOREAN_DIGITS.get(ch, ch) for ch in raw)
    s = s.strip()
    if s.startswith("+82"):
        s = "0" + s[3:].lstrip(" -")
    digits = re.sub(r"\D", "", s)
    if re.fullmatch(r"1[568]\d{6}", digits):
        return digits
    if digits.startswith("010"):
        return digits if len(digits) == 11 else None
    if digits.startswith("0") and 9 <= len(digits) <= 11:
        return digits
    return None
