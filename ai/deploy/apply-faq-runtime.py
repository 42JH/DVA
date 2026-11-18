"""운영 서버의 명시적인 FAQ 활성화 선택만 새 릴리스에 적용한다. 비밀 파일은 열지 않는다."""

import json
import os
from pathlib import Path
import re
import sys
import tomllib


def apply(override: Path, target: Path):
    if not override.exists():
        return
    values = json.loads(override.read_text(encoding="utf-8"))
    keys = {"receive_enabled", "process_enabled"}
    if not isinstance(values, dict) or set(values) != keys or any(type(v) is not bool for v in values.values()):
        raise ValueError("FAQ 운영 선택은 두 활성화 항목의 boolean 값만 허용합니다.")
    if values["process_enabled"] and not values["receive_enabled"]:
        raise ValueError("FAQ 자동 처리에는 수신 활성화가 필요합니다.")
    raw = target.read_text(encoding="utf-8")
    parsed = tomllib.loads(raw)
    if not isinstance(parsed.get("faq_sync"), dict):
        raise ValueError("FAQ 설정을 지원하지 않는 릴리스에는 운영 선택을 적용할 수 없습니다.")
    sections = re.split(r"(?m)(^\[faq_sync\][ \t]*(?:#.*)?$)", raw)
    if len(sections) != 3:
        raise ValueError("FAQ 설정 절을 확인하세요.")
    body = re.split(r"(?m)(?=^\[)", sections[2], maxsplit=1)
    for key, value in values.items():
        body[0], count = re.subn(rf"(?m)^{key}[ \t]*=[ \t]*(?:true|false)[ \t]*(?:#.*)?$",
                                f"{key} = {str(value).lower()}", body[0])
        if count != 1:
            raise ValueError("FAQ 활성화 항목이 없거나 중복됩니다.")
    updated = sections[0] + sections[1] + "".join(body)
    tomllib.loads(updated)
    temporary = target.with_name(target.name + ".faq-runtime.tmp")
    try:
        temporary.write_text(updated, encoding="utf-8")
        temporary.chmod(target.stat().st_mode & 0o777)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    apply(Path(sys.argv[1]), Path(sys.argv[2]))
