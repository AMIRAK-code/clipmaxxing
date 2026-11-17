"""YouTube import: one honest progress number across the picture and sound files, and the quality choice."""
from __future__ import annotations

from klipz_worker.steps import youtube as yt


def test_quality_choice():
    assert yt.pick_height("auto", 600) == 1080
    assert yt.pick_height("auto", 2 * 3600) == 720  # a long stream: half the download
    assert yt.pick_height(None, None) == 1080
    assert yt.pick_height("720", 60) == 720 and yt.pick_height("480p", 9000) == 480 and yt.pick_height("1080", 9000) == 1080
    assert yt.pick_height("nonsense", 60) == 1080
    sel = yt.format_selector(720)
    assert sel.count("[height<=720]") == 4 and sel.endswith("/b")


def test_human_readable_numbers():
    assert yt.human_bytes(1_250_000_000) == "1.25 GB" and yt.human_bytes(12_400_000) == "12.4 MB" and yt.human_bytes(900) == "1 KB"
    assert yt.human_left(0.2) == "1 s left" and yt.human_left(42) == "42 s left"
    assert yt.human_left(200) == "3 min left" and yt.human_left(3900) == "1 h 5 min left"


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def run(events: list[dict], plan: dict | None) -> list[tuple[float, str | None]]:
    out: list[tuple[float, str | None]] = []
    clock = Clock()
    tracker = yt.DownloadProgress(lambda p, text=None: out.append((p, text)), clock)
    if plan:
        tracker.plan(plan)
    for e in events:
        clock.t = e.pop("at")
        (tracker.on_postprocess if "postprocessor" in e else tracker.on_download)(e)
    return out


def test_two_files_count_as_one_download_and_never_go_backwards():
    plan = {"duration": 100, "requested_formats": [{"format_id": "399", "filesize": 80_000_000}, {"format_id": "140", "filesize_approx": 20_000_000}]}
    video, audio = {"format_id": "399"}, {"format_id": "140"}
    out = run([
        {"at": 0.0, "status": "downloading", "info_dict": video, "downloaded_bytes": 0, "total_bytes": 80_000_000},
        {"at": 1.0, "status": "downloading", "info_dict": video, "downloaded_bytes": 40_000_000, "total_bytes": 80_000_000},
        {"at": 2.0, "status": "finished", "info_dict": video, "downloaded_bytes": 80_000_000, "total_bytes": 80_000_000},
        {"at": 2.1, "status": "downloading", "info_dict": audio, "downloaded_bytes": 0, "total_bytes": 20_000_000},
        {"at": 3.1, "status": "downloading", "info_dict": audio, "downloaded_bytes": 10_000_000, "total_bytes": 20_000_000},
        {"at": 3.5, "status": "finished", "info_dict": audio, "downloaded_bytes": 20_000_000, "total_bytes": 20_000_000},
        {"at": 3.6, "postprocessor": "Merger", "status": "started"},
    ], plan)
    fractions = [p for p, _ in out]
    assert fractions == sorted(fractions)
    # half of the picture file is 40 % of the whole download, not 50 %
    assert fractions[1] == 0.97 * 0.4
    # the picture file finishing is 80 %; the old bar read 99 % here and then started over
    assert abs(fractions[2] - 0.97 * 0.8) < 1e-9
    assert out[1][1] == "Downloading · 40.0 MB of 100.0 MB · 40.0 MB/s · 2 s left"
    assert out[-2] == (0.97, "Downloading · 100.0 MB of 100.0 MB")
    assert out[-1] == (0.97, "Joining picture and sound")


def test_text_is_refreshed_once_a_second_and_sizes_fall_back_to_bitrate():
    plan = {"duration": 80, "requested_formats": [{"format_id": "v", "tbr": 1000}]}  # 1000 kbit/s * 80 s = 10 MB
    info = {"format_id": "v"}
    out = run([{"at": t / 10, "status": "downloading", "info_dict": info, "downloaded_bytes": t * 100_000} for t in range(0, 31)], plan)
    texts = [text for _, text in out if text]
    assert len(out) == 31 and len(texts) == 4  # at 0, 1, 2 and 3 seconds
    assert texts[1].startswith("Downloading · 1.0 MB of 10.0 MB · 1.0 MB/s")


def test_without_a_plan_or_matching_ids_it_still_adds_up():
    # a single combined file, no plan
    out = run([{"at": 0.0, "status": "downloading", "filename": "a.mp4", "downloaded_bytes": 5_000_000, "total_bytes_estimate": 10_000_000}], None)
    assert out[0][0] == 0.97 * 0.5
    # ids in the events differ from the planned ones: files are matched to the plan in order
    plan = {"requested_formats": [{"format_id": "1", "filesize": 60_000_000}, {"format_id": "2", "filesize": 40_000_000}]}
    out = run([
        {"at": 0.0, "status": "finished", "filename": "x.f1.mp4", "downloaded_bytes": 60_000_000, "total_bytes": 60_000_000},
        {"at": 1.0, "status": "downloading", "filename": "x.f2.m4a", "downloaded_bytes": 20_000_000, "total_bytes": 40_000_000},
    ], plan)
    assert abs(out[0][0] - 0.97 * 0.6) < 1e-9 and abs(out[1][0] - 0.97 * 0.8) < 1e-9
