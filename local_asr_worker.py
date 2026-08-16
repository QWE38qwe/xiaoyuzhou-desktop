#!/usr/bin/env python3
import argparse
import contextlib
import json
import sys


ALLOWED_MODELS = {
    "Qwen/Qwen3-ASR-0.6B",
    "Qwen/Qwen3-ASR-1.7B",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True, choices=sorted(ALLOWED_MODELS))
    parser.add_argument("--language", default="Chinese")
    args = parser.parse_args()

    from mlx_qwen3_asr import transcribe

    with contextlib.redirect_stdout(sys.stderr):
        result = transcribe(
            args.audio,
            model=args.model,
            language=args.language,
            return_chunks=True,
            return_timestamps=True,
            verbose=False,
        )
    text = str(result.text or "").strip()
    if not text:
        raise RuntimeError("本地 Qwen ASR 未返回文本")
    raw_segments = getattr(result, "segments", None) or getattr(result, "chunks", None) or []
    segments = []
    for item in raw_segments:
        if isinstance(item, dict):
            segment_text = str(item.get("text") or "").strip()
            start = item.get("start")
            end = item.get("end")
        else:
            segment_text = str(getattr(item, "text", "") or "").strip()
            start = getattr(item, "start", None)
            end = getattr(item, "end", None)
        if not segment_text or start is None:
            continue
        try:
            start_value = max(0.0, float(start))
            end_value = max(start_value, float(end if end is not None else start))
        except (TypeError, ValueError):
            continue
        segments.append(
            {"text": segment_text, "start": start_value, "end": end_value}
        )
    segments.sort(key=lambda item: item["start"])
    print(
        json.dumps(
            {
                "text": text,
                "segments": segments,
                "language": str(result.language or ""),
                "model": args.model,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
