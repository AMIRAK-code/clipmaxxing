#!/usr/bin/env python
"""Generate a realistic local test video with no network access.

~75 s, 1280x720, 30 fps, six visually distinct shots (hard cuts), with REAL
speech synthesised offline by Windows SAPI (System.Speech) reading a ~170 word
script. On non-Windows machines it falls back to tone bursts.

Writes <data dir>/samples/sample.mp4 and prints the path.
Run with the worker venv:  python scripts/make-sample.py [--out PATH]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

SCRIPT = [
    "Why do most people never finish what they start?",
    "I spent ten years getting this wrong, and it cost me nearly fifty thousand dollars.",
    "Here is the thing nobody tells you about motivation.",
    "It fades after about three days, every single time.",
    "So you do not need a feeling, you need a system.",
    "Rule number one is to make the task tiny.",
    "Write one sentence a day, and in ninety days you will have a book.",
    "Rule number two is to never skip two days in a row.",
    "Missing once is an accident, and missing twice is the start of a new habit.",
    "Rule number three is to track it where you can see it.",
    "A simple calendar with red crosses beats any fancy app.",
    "Last year I followed these three rules and finished two projects that I had abandoned for a decade.",
    "The payoff is simple: small steps, repeated daily, beat big plans that never begin.",
    "Start today, make it tiny, and do not break the chain.",
]
DURATION = 75.0
SHOTS = 6
LEAD_IN = 1.0

DATA_DIR = Path(os.environ.get("KLIPZ_DATA_DIR", "").strip() or Path.home() / ".klipz")


def ffmpeg_bin() -> str:
    import shutil

    found = shutil.which("ffmpeg")
    if found:
        return found
    from static_ffmpeg import run  # type: ignore[import-not-found]

    return run.get_or_fetch_platform_executables_else_raise()[0]


def run(cmd: list[str]) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if res.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(cmd[:3])} ...\n{res.stderr[-1500:]}")


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def speech_sapi(out_wav: Path, work: Path) -> bool:
    """Windows SAPI: one sentence per line, a short pause between them."""
    if sys.platform != "win32":
        return False
    txt = work / "script.txt"
    txt.write_text("\n".join(SCRIPT), encoding="utf-8")
    ps1 = work / "say.ps1"
    q = lambda x: str(x).replace("'", "''")  # PowerShell single-quote escaping (paths may contain ')
    ps1.write_text(
        "Add-Type -AssemblyName System.Speech\n"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
        "$s.Rate = 0\n"
        f"$s.SetOutputToWaveFile('{q(out_wav)}')\n"
        f"foreach ($line in Get-Content -Encoding UTF8 -LiteralPath '{q(txt)}') {{\n"
        "  if ($line.Trim().Length -gt 0) {\n"
        "    $s.Speak($line)\n"
        "    $pb = New-Object System.Speech.Synthesis.PromptBuilder\n"
        "    $pb.AppendBreak([TimeSpan]::FromMilliseconds(900))\n"
        "    $s.Speak($pb)\n"
        "  }\n"
        "}\n"
        "$s.Dispose()\n",
        encoding="utf-8",
    )
    res = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps1)],
        capture_output=True, text=True, errors="replace",
    )
    if res.returncode != 0 or not out_wav.exists() or out_wav.stat().st_size < 10_000:
        print("SAPI speech failed, using tone bursts:", res.stderr.strip()[:300], file=sys.stderr)
        return False
    return True


def speech_tones(out_wav: Path, ff: str) -> None:
    """Non-Windows fallback: one tone burst per sentence."""
    run([ff, "-hide_banner", "-y", "-f", "lavfi", "-i",
         f"aevalsrc='0.4*sin(2*PI*(220+40*floor(t/4))*t)*lt(mod(t,4),2.8)':s=22050:d={len(SCRIPT) * 4}",
         "-c:a", "pcm_s16le", str(out_wav)])


def find_font() -> str | None:
    for p in (
        "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
    ):
        if Path(p).exists():
            return p
    return None


def shot_sources(dur: float, font: str | None) -> list[str]:
    """lavfi inputs, each visually distinct, 1280x720@30."""
    size, d = "size=1280x720:rate=30", f"duration={dur:.3f}"
    return [
        f"testsrc2={size}:{d}",
        f"smptebars={size}:{d}",
        f"mandelbrot=size=1280x720:rate=30:end_scale=0.02:start_scale=3",
        f"gradients={size}:{d}:speed=0.05",
        f"color=c=0x1d3557:size=1280x720:rate=30:{d}",
        f"rgbtestsrc={size}:{d}",
    ]


def make_video(speech: Path, out: Path, total: float, ff: str) -> None:
    font = find_font()
    per = total / SHOTS
    sources = shot_sources(per, font)
    args = [ff, "-hide_banner", "-y"]
    for i, src in enumerate(sources):
        if src.startswith("mandelbrot"):
            args += ["-f", "lavfi", "-t", f"{per:.3f}", "-i", src]
        else:
            args += ["-f", "lavfi", "-i", src]
    args += ["-i", str(speech)]
    chains = []
    for i in range(SHOTS):
        label = f"SHOT {i + 1}"
        v = f"[{i}:v]scale=1280:720,setsar=1,format=yuv420p,trim=duration={per:.3f},setpts=PTS-STARTPTS"
        if font:
            f = font.replace(":", "\\:")
            v += (f",drawtext=fontfile='{f}':text='{label}':fontsize=54:fontcolor=white:box=1:boxcolor=black@0.6:"
                  f"boxborderw=14:x=40:y=40")
        chains.append(f"{v}[v{i}]")
    concat = "".join(f"[v{i}]" for i in range(SHOTS)) + f"concat=n={SHOTS}:v=1:a=0,fps=30[v]"
    delay = int(LEAD_IN * 1000)
    audio = f"[{SHOTS}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={delay}|{delay},apad=whole_dur={total:.3f}[a]"
    args += ["-filter_complex", ";".join(chains + [concat, audio]), "-map", "[v]", "-map", "[a]",
             "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)]
    run(args)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DATA_DIR / "samples" / "sample.mp4")
    args = ap.parse_args()
    ff = ffmpeg_bin()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="klipz-sample-") as tmp:
        work = Path(tmp)
        wav = work / "speech.wav"
        if not speech_sapi(wav, work):
            speech_tones(wav, ff)
        total = max(DURATION, wav_duration(wav) + LEAD_IN + 2.0)
        make_video(wav, args.out, total, ff)
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
