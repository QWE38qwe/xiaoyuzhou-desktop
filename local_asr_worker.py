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
            verbose=False,
        )
    text = str(result.text or "").strip()
    if not text:
        raise RuntimeError("本地 Qwen ASR 未返回文本")
    print(
        json.dumps(
            {
                "text": text,
                "language": str(result.language or ""),
                "model": args.model,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
