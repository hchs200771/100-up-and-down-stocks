"""本機語音轉文字（faster-whisper，CPU int8），給 fetch-kol-feeds.ts 的 KOL_TRANSCRIBE_CMD 用。

用法：python transcribe-local.py <音檔> <輸出純文字檔>
模型用 KOL_WHISPER_MODEL（預設 small）。Whisper 常吐簡體，最後用 OpenCC 轉台灣繁體。
"""
import os
import sys
import time

from faster_whisper import WhisperModel
from opencc import OpenCC

PROMPT = "以下是台灣財經節目的繁體中文逐字稿，內容會提到台股、美股、台積電、輝達、聯準會、股癌、財報狗、ETF。"


def main() -> None:
    audio, out = sys.argv[1], sys.argv[2]
    model = WhisperModel(os.environ.get("KOL_WHISPER_MODEL", "small"), device="cpu", compute_type="int8")
    started = time.time()
    segments, info = model.transcribe(
        audio,
        language="zh",
        initial_prompt=PROMPT,
        beam_size=int(os.environ.get("KOL_WHISPER_BEAM", "1")),
        vad_filter=True,
    )
    text = " ".join(seg.text.strip() for seg in segments)
    text = OpenCC("s2twp").convert(text)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"transcribe-local: {info.duration:.0f}s audio in {time.time() - started:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
