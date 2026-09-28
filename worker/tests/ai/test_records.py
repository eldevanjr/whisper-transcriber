from __future__ import annotations

from transcriber_worker.ai.records import metadata_from


def test_metadata_from_handles_every_shape() -> None:
    assert metadata_from({"a": 1}) == {"a": 1}
    assert metadata_from('{"a": 1}') == {"a": 1}
    assert metadata_from("[]") == {}
    assert metadata_from(None) == {}
