"""새 릴리스와 롤백 대상의 FAQ 운영 선택 적용. 외부 서비스 호출 없음."""

import importlib.util
import json
from pathlib import Path
import tomllib

import pytest


spec = importlib.util.spec_from_file_location("faq_runtime_deploy", Path(__file__).parents[1] / "deploy/apply-faq-runtime.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def files(tmp_path):
    target = tmp_path / "server.toml"
    target.write_text('[other]\nkeep = "유지"\n[faq_sync]\nreceive_enabled = false\nprocess_enabled = false\ncollection = "keep"\n[after]\nreceive_enabled = false\n', encoding="utf-8")
    return tmp_path / "faq-runtime.json", target


def test_absent_override_preserves_defaults(files):
    override, target = files
    before = target.read_bytes()
    module.apply(override, target)
    assert target.read_bytes() == before


@pytest.mark.parametrize("enabled", [True, False])
def test_explicit_selection_preserves_other_settings(files, enabled):
    override, target = files
    override.write_text(json.dumps(dict(receive_enabled=enabled, process_enabled=enabled)))
    module.apply(override, target)
    result = tomllib.loads(target.read_text(encoding="utf-8"))
    assert result["faq_sync"] == dict(receive_enabled=enabled, process_enabled=enabled, collection="keep")
    assert result["other"]["keep"] == "유지"
    assert result["after"]["receive_enabled"] is False


@pytest.mark.parametrize("values", [dict(receive_enabled=1, process_enabled=True),
    dict(receive_enabled=False, process_enabled=True), dict(receive_enabled=True, process_enabled=True, unexpected=True)])
def test_invalid_selection_does_not_change_release(files, values):
    override, target = files
    before = target.read_bytes()
    override.write_text(json.dumps(values))
    with pytest.raises(ValueError):
        module.apply(override, target)
    assert target.read_bytes() == before


def test_unsupported_old_release_is_not_silently_activated(files):
    override, target = files
    override.write_text(json.dumps(dict(receive_enabled=True, process_enabled=True)))
    target.write_text('[other]\nkeep = true\n')
    before = target.read_bytes()
    with pytest.raises(ValueError):
        module.apply(override, target)
    assert target.read_bytes() == before
