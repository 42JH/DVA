"""Workflow Policy 로더(policy/workflow.toml). 읽을 때 정합성을 검사한다 — 잘못된 정책으로 서버가 뜨지 않게.

이 모듈은 데이터만 다룬다(SDK·HTTP 의존 없음). 지시문 렌더링은 render.py, 판정은 app/domain/.
"""

import tomllib
from datetime import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config import ROOT

DecisionSet = Literal["intent", "collect", "confirm", "pick", "more", "off"]
# pick은 후보 이름표가 통화마다 달라 정책에 질문을 두지 않고 서버가 만든다(delegation.md §3.2)
STATIC_DECISION_SETS = ("intent", "collect", "confirm", "more", "callback", "origin", "sender_change", "sender_name_scope", "box")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FieldSpec(_Strict):
    label: str = Field(min_length=1)
    kind: Literal["free", "choice", "auto"]
    scope: Literal["parcel", "call"] = "parcel"


class Stage(_Strict):
    id: str = Field(min_length=1)
    goal: str = Field(min_length=1)
    required: tuple[str, ...] = ()
    rule: str | None = None
    gate: Literal["server"] | None = None
    decision: tuple[DecisionSet, ...] = ("off",)   # 한 단계에 세트 여러 개 가능(예: more + collect)

    @model_validator(mode="before")
    @classmethod
    def one_or_many(cls, data):
        if isinstance(data, dict) and isinstance(data.get("decision"), str):
            data = {**data, "decision": (data["decision"],)}
        return data


class Question(_Strict):
    name: str = Field(min_length=1)
    type: Literal["choice", "predicate", "score"]  # 자유형 추출 질문은 둘 수 없다(D1)
    instructions: str = Field(min_length=1)
    choices: tuple[str, ...] = ()

    @model_validator(mode="after")
    def choices_for_choice(self):
        if self.type == "choice" and not 2 <= len(self.choices) <= 255:
            raise ValueError(f"choice 질문 {self.name}: 선택지 2~255개")
        return self


class DecisionSpec(_Strict):
    questions: tuple[Question, ...] = Field(min_length=1)


class Forbid(_Strict):
    items: tuple[str, ...] = Field(min_length=1)


class Pickup(_Strict):
    """수거 요청 시각 업무 규칙(app/domain/pickup.py). 시각은 "HH:MM"(한국 시간)."""
    min_lead_minutes: int = Field(ge=0)
    open: str
    close: str
    max_days_ahead: int = Field(gt=0)
    next_day_default: str

    @model_validator(mode="after")
    def valid_window(self):
        start, end, default = map(time.fromisoformat, (self.open, self.close, self.next_day_default))
        if not start <= default <= end:
            raise ValueError("수거 기본 시각은 영업시간 안이어야 합니다")
        if self.min_lead_minutes > self.max_days_ahead * 24 * 60:
            raise ValueError("수거 최소 준비 시간이 최대 범위를 넘습니다")
        return self


class InputLimits(_Strict):
    item_price_min: int = Field(gt=0)
    item_price_max: int = Field(gt=0)
    box_total_max: int = Field(gt=0)
    document_max: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_price_range(self):
        if self.item_price_min > self.item_price_max:
            raise ValueError("물품 가액 최소값이 최대값을 넘습니다")
        return self


class ItemRestriction(_Strict):
    kind: Literal["prohibited", "conditional", "format"]
    terms: tuple[str, ...] = Field(min_length=1)
    excluded_terms: tuple[str, ...] = ()
    guidance: str = Field(min_length=1)


class ParcelItems(_Strict):
    max_side_cm: int = Field(gt=0)
    max_weight_kg: int = Field(gt=0)
    rules: dict[str, ItemRestriction]


class Phone(_Strict):
    mobile_prefix: str
    mobile_digits: int = Field(gt=0)
    domestic_min_digits: int = Field(gt=0)
    domestic_max_digits: int = Field(gt=0)
    service_prefixes: tuple[str, ...] = Field(min_length=1)
    service_digits: int = Field(gt=0)

    @model_validator(mode="after")
    def valid_format(self):
        if not self.mobile_prefix.startswith("0") or not self.mobile_prefix.isdigit():
            raise ValueError("휴대전화 접두번호 오류")
        if len(self.mobile_prefix) > self.mobile_digits or self.domestic_min_digits > self.domestic_max_digits:
            raise ValueError("전화번호 자릿수 오류")
        if any(not p.isdigit() or len(p) > self.service_digits for p in self.service_prefixes):
            raise ValueError("대표번호 접두번호 오류")
        return self


class Reask(_Strict):
    max_attempts: int = Field(gt=0)
    vary_wording: bool = True


class Confirm(_Strict):
    yes_min: float = Field(gt=0, le=1)
    change_max: float = Field(gt=0, le=1)
    answer_after_readback_tolerance_ms: int = Field(ge=0)


class Address(_Strict):
    ambiguous: Literal["auto_select_top"]


class Policy(_Strict):
    version: str
    fields: dict[str, FieldSpec]
    stage: tuple[Stage, ...]
    pickup: Pickup
    input_limits: InputLimits
    parcel_items: ParcelItems
    phone: Phone
    reask: Reask
    confirm: Confirm
    address: Address
    forbid: Forbid
    speech: dict[str, str]
    results: dict[str, str] = {}       # 서버 결과 키 → 뜻(Live 지시문)
    decision: dict[str, DecisionSpec]

    @model_validator(mode="after")
    def consistent(self):
        ids = [s.id for s in self.stage]
        if len(set(ids)) != len(ids):
            raise ValueError("단계 id 중복")
        for s in self.stage:
            unknown = [f for f in s.required if f not in self.fields]
            if unknown:
                raise ValueError(f"단계 {s.id}: 모르는 필드 {unknown}")
            for d in s.decision:
                if d in STATIC_DECISION_SETS and d not in self.decision:
                    raise ValueError(f"단계 {s.id}: 질문 세트 {d} 없음")
            if s.gate and s.required:
                raise ValueError(f"단계 {s.id}: gate 단계는 수집 항목을 두지 않는다(서버가 판정)")
        collected = [f for s in self.stage for f in s.required]
        if len(set(collected)) != len(collected):
            raise ValueError("한 필드가 두 단계에 들어 있음")
        unknown = set(self.decision) - set(STATIC_DECISION_SETS)
        if unknown:
            raise ValueError(f"모르는 질문 세트 {sorted(unknown)}")
        return self

    # --- 파생 값(판정·렌더링이 같은 출처를 쓰게) ---
    def collect_stages(self) -> list[Stage]:
        return [s for s in self.stage if s.required]

    def stage_by_id(self, stage_id: str) -> Stage:
        return next(s for s in self.stage if s.id == stage_id)

    def parcel_fields(self) -> list[str]:
        """택배마다 받는 필드, 받는 순서대로(auto 포함: sender_phone은 sender 단계 앞에 둔다)."""
        ordered = [f for s in self.collect_stages() for f in s.required if self.fields[f].scope == "parcel"]
        auto = [f for f, spec in self.fields.items() if spec.kind == "auto" and spec.scope == "parcel"]
        return auto + ordered

    def free_fields(self) -> list[str]:
        return [f for s in self.collect_stages() for f in s.required if self.fields[f].kind == "free"]


def load_policy(path: Path | None = None) -> Policy:
    with (path or ROOT / "policy" / "workflow.toml").open("rb") as f:
        return Policy.model_validate(tomllib.load(f))
