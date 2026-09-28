from __future__ import annotations

import pytest

from transcriber_worker.ai.windows import SegmentInput, build_windows


def _seg(index: int, start: float, end: float, text: str) -> SegmentInput:
    return SegmentInput(index=index, start=start, end=end, text=text)


def test_empty_segments() -> None:
    assert build_windows([], transcription_id="t", window_seconds=45.0, overlap_seconds=10.0) == []


def test_invalid_overlap() -> None:
    with pytest.raises(ValueError, match="overlap"):
        build_windows(
            [_seg(0, 0.0, 1.0, "a")],
            transcription_id="t",
            window_seconds=10.0,
            overlap_seconds=10.0,
        )


def test_windows_with_overlap() -> None:
    segments = [_seg(0, 0.0, 20.0, "a"), _seg(1, 20.0, 40.0, "b"), _seg(2, 40.0, 60.0, "c")]
    windows = build_windows(
        segments, transcription_id="t", window_seconds=30.0, overlap_seconds=10.0
    )
    assert [(w.start, w.end) for w in windows] == [(0.0, 30.0), (20.0, 50.0), (40.0, 60.0)]
    assert [w.segment_indices for w in windows] == [[0, 1], [1, 2], [2]]
    assert windows[0].text == "a b"
    assert windows[0].transcription_id == "t"
    assert [w.index for w in windows] == [0, 1, 2]
    assert all(w.id for w in windows)


def test_gaps_produce_no_empty_windows() -> None:
    segments = [_seg(0, 0.0, 1.0, "inicio"), _seg(1, 100.0, 101.0, "fim")]
    windows = build_windows(
        segments, transcription_id="t", window_seconds=10.0, overlap_seconds=0.0
    )
    assert [(w.start, w.end) for w in windows] == [(0.0, 10.0), (100.0, 101.0)]
    assert windows[-1].text == "fim"


def test_segments_are_sorted_before_windowing() -> None:
    segments = [_seg(2, 40.0, 60.0, "c"), _seg(0, 0.0, 20.0, "a"), _seg(1, 20.0, 40.0, "b")]
    windows = build_windows(
        segments, transcription_id="t", window_seconds=60.0, overlap_seconds=0.0
    )
    assert windows[0].segment_indices == [0, 1, 2]
    assert windows[0].text == "a b c"
