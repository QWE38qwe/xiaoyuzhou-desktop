#!/usr/bin/env python3
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse


VERSION = "0.2.1"
INVALID_FILENAME = re.compile(r'[\\/:*?"<>|]')
RUNTIME_DIR = Path(__file__).resolve().parent
CREDENTIALS_PATH = RUNTIME_DIR / "asr_credentials.json"
FUN_ASR_MAX_DURATION_SECONDS = 5 * 60


def read_exact(size):
    chunks = []
    remaining = size
    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise EOFError("Native message ended unexpectedly")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message():
    length_data = sys.stdin.buffer.read(4)
    if not length_data:
        return None
    length = struct.unpack("<I", length_data)[0]
    if length > 1024 * 1024:
        raise ValueError("Native message is too large")
    return json.loads(read_exact(length).decode("utf-8"))


def write_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def absolute_directory(value):
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("目录不能为空")
    path = Path(os.path.expanduser(raw))
    if not path.is_absolute():
        raise ValueError("目录必须是系统绝对路径")
    return path.resolve()


def ensure_directory(value):
    path = absolute_directory(value)
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError(f"目标不是目录：{path}")
    if not os.access(path, os.W_OK):
        raise PermissionError(f"目录不可写：{path}")
    return path


def safe_filename(value):
    name = Path(str(value or "xiaoyuzhou-audio.m4a")).name
    name = INVALID_FILENAME.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:180] or "xiaoyuzhou-audio.m4a"


def markdown_transcript(title, text):
    heading = re.sub(r"[\r\n]+", " ", str(title or "转写稿")).strip() or "转写稿"
    body = str(text or "").strip()
    return f"# {heading}\n\n## 转写正文\n\n{body}\n"


def unique_path(directory, filename):
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    index = 1
    while True:
        candidate = directory / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def choose_directory(prompt):
    script = (
        "on run argv\n"
        "return POSIX path of (choose folder with prompt (item 1 of argv))\n"
        "end run"
    )
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script, str(prompt or "请选择保存目录")],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("已取消选择目录")
    return str(absolute_directory(result.stdout.strip()))


def download_audio(message):
    parsed = urlparse(str(message.get("url") or ""))
    if parsed.scheme != "https":
        raise ValueError("只支持下载 HTTPS 音频")
    directory = ensure_directory(message.get("directory"))
    destination = unique_path(directory, safe_filename(message.get("filename")))
    request = urllib.request.Request(
        parsed.geturl(),
        headers={
            "Accept": "*/*",
            "Referer": "https://www.xiaoyuzhoufm.com/",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 Chrome/147 Safari/537.36",
        },
    )
    temporary = tempfile.NamedTemporaryFile(
        prefix=f".{destination.name}.",
        suffix=".part",
        dir=str(directory),
        delete=False,
    )
    temporary_path = Path(temporary.name)
    try:
        with temporary, urllib.request.urlopen(request, timeout=60) as response:
            final_url = urlparse(response.geturl())
            if final_url.scheme != "https":
                raise ValueError("音频下载发生了不安全重定向")
            shutil.copyfileobj(response, temporary, length=1024 * 1024)
        os.replace(temporary_path, destination)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return {"path": str(destination), "bytes": destination.stat().st_size}


def load_credentials():
    if not CREDENTIALS_PATH.exists():
        return {}
    return json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))


def save_asr_credentials(values):
    current = load_credentials()
    for key in ("qwenApiKey", "doubaoApiKey"):
        value = str(values.get(key) or "").strip()
        if value:
            current[key] = value
    CREDENTIALS_PATH.write_text(
        json.dumps(current, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(CREDENTIALS_PATH, 0o600)
    return {
        "qwenConfigured": bool(current.get("qwenApiKey")),
        "doubaoConfigured": bool(current.get("doubaoApiKey")),
    }


def validate_endpoint(value, provider):
    parsed = urlparse(str(value or ""))
    if parsed.scheme != "https":
        raise ValueError("ASR 接口必须使用 HTTPS")
    host = (parsed.hostname or "").lower()
    if provider == "qwen":
        allowed = (
            host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"}
            or host.endswith(".maas.aliyuncs.com")
        )
    else:
        allowed = host == "openspeech.bytedance.com"
    if not allowed:
        raise ValueError(f"{provider} ASR 接口域名不受信任")
    return parsed.geturl()


def request_json(url, body, headers, timeout=4 * 60 * 60):
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload or "{}"), response.headers
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ASR API 请求失败（{error.code}）：{payload[:1000]}") from error


def get_json(url, headers, timeout=60):
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ASR API 查询失败（{error.code}）：{payload[:1000]}") from error


def find_media_tool(name):
    discovered = shutil.which(name)
    if discovered:
        return discovered
    for directory in ("/opt/homebrew/bin", "/usr/local/bin"):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def probe_audio_duration(audio_path):
    ffprobe = find_media_tool("ffprobe")
    if not ffprobe:
        raise RuntimeError("Fun-ASR 转写需要 ffprobe，请先执行 brew install ffmpeg")
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(audio_path),
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"无法读取音频时长：{result.stderr[-1000:]}")
    try:
        return float(json.loads(result.stdout)["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("无法读取音频时长") from error


def qwen_fun_asr_audio_data(message):
    audio_directory = ensure_directory(message.get("audioDirectory"))
    audio_filename = safe_filename(message.get("audioFilename"))
    audio_path = audio_directory / audio_filename
    if not audio_path.exists():
        downloaded = download_audio(
            {"url": message.get("url"), "directory": str(audio_directory), "filename": audio_filename}
        )
        audio_path = Path(downloaded["path"])

    duration = probe_audio_duration(audio_path)
    if duration > FUN_ASR_MAX_DURATION_SECONDS:
        raise RuntimeError(
            f"Fun-ASR-Flash 单次最多转写 5 分钟，当前音频约 {duration / 60:.1f} 分钟"
        )

    ffmpeg = find_media_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Fun-ASR 转写需要 ffmpeg，请先执行 brew install ffmpeg")
    with tempfile.TemporaryDirectory(prefix="xiaoyuzhou-qwen-") as temporary:
        mp3_path = Path(temporary) / "audio.mp3"
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(audio_path),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-b:a",
                "48k",
                str(mp3_path),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"音频转换失败：{result.stderr[-1000:]}")
        encoded = base64.b64encode(mp3_path.read_bytes()).decode("ascii")
        return f"data:audio/mpeg;base64,{encoded}"


def transcribe_qwen(message, api_key):
    endpoint = validate_endpoint(message.get("qwenEndpoint"), "qwen")
    model = str(message.get("qwenModel") or "qwen-audio-3.0-asr-flash-filetrans")
    if model.endswith("filetrans"):
        payload, _ = request_json(
            endpoint,
            {
                "model": model,
                "input": {"file_urls": [str(message.get("url") or "")]},
                "parameters": {
                    "language_hints": [str(message.get("language") or "zh")],
                },
            },
            {
                "Authorization": f"Bearer {api_key}",
                "X-DashScope-Async": "enable",
            },
        )
        task_id = str((payload.get("output") or {}).get("task_id") or "")
        if not task_id:
            raise RuntimeError(
                f"Qwen ASR 未返回任务 ID：{json.dumps(payload, ensure_ascii=False)[:1000]}"
            )
        parsed = urlparse(endpoint)
        query_url = f"{parsed.scheme}://{parsed.netloc}/api/v1/tasks/{task_id}"
        deadline = time.monotonic() + 4 * 60 * 60
        while time.monotonic() < deadline:
            task = get_json(
                query_url,
                {
                    "Authorization": f"Bearer {api_key}",
                    "X-DashScope-Async": "enable",
                },
            )
            output = task.get("output") or {}
            status = output.get("task_status")
            if status == "SUCCEEDED":
                results = output.get("results") or []
                result_url = str(
                    (results[0] if results else output.get("result") or {}).get(
                        "transcription_url"
                    )
                    or ""
                )
                if not result_url:
                    raise RuntimeError("Qwen ASR 任务成功但未返回转写结果地址")
                result = get_json(result_url, {})
                transcripts = result.get("transcripts") or []
                text = "\n".join(
                    str(item.get("text") or "").strip()
                    for item in transcripts
                    if str(item.get("text") or "").strip()
                )
                if not text:
                    raise RuntimeError("Qwen ASR 未返回转写文本")
                return text
            if status in {"FAILED", "UNKNOWN"}:
                raise RuntimeError(
                    f"Qwen ASR 任务失败：{json.dumps(output, ensure_ascii=False)[:1000]}"
                )
            time.sleep(2)
        raise TimeoutError("Qwen ASR 转写超时")

    if model.startswith("fun-asr-flash"):
        body = {
            "model": model,
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_audio",
                                "input_audio": {
                                    "data": qwen_fun_asr_audio_data(message)
                                },
                            }
                        ],
                    }
                ]
            },
            "parameters": {
                "format": "mp3",
                "sample_rate": "16000",
                "language_hints": [str(message.get("language") or "zh")],
            },
        }
        payload, _ = request_json(
            endpoint,
            body,
            {
                "Authorization": f"Bearer {api_key}",
                "X-DashScope-SSE": "disable",
            },
        )
        text = str((payload.get("output") or {}).get("text") or "").strip()
        if not text:
            raise RuntimeError(
                f"Qwen Fun-ASR 未返回文本：{json.dumps(payload, ensure_ascii=False)[:1000]}"
            )
        return text

    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": str(message.get("url") or "")},
                    }
                ],
            }
        ],
        "stream": False,
        "asr_options": {
            "language": str(message.get("language") or "zh"),
            "enable_itn": True,
        },
    }
    payload, _ = request_json(
        endpoint,
        body,
        {"Authorization": f"Bearer {api_key}"},
    )
    try:
        return str(payload["choices"][0]["message"]["content"]).strip()
    except (KeyError, IndexError, TypeError) as error:
        raise RuntimeError(f"Qwen ASR 返回格式异常：{json.dumps(payload, ensure_ascii=False)[:1000]}") from error


def doubao_audio_input(message):
    url = str(message.get("url") or "")
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".wav", ".mp3", ".ogg", ".opus"}:
        return {"url": url}

    audio_directory = ensure_directory(message.get("audioDirectory"))
    audio_filename = safe_filename(message.get("audioFilename"))
    audio_path = audio_directory / audio_filename
    if not audio_path.exists():
        downloaded = download_audio(
            {"url": url, "directory": str(audio_directory), "filename": audio_filename}
        )
        audio_path = Path(downloaded["path"])
    ffmpeg = find_media_tool("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("豆包转写 M4A 需要 ffmpeg，请先执行 brew install ffmpeg")
    with tempfile.TemporaryDirectory(prefix="xiaoyuzhou-doubao-") as temporary:
        mp3_path = Path(temporary) / "audio.mp3"
        result = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(audio_path),
                "-ac",
                "1",
                "-b:a",
                "48k",
                str(mp3_path),
            ],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"音频转换失败：{result.stderr[-1000:]}")
        if mp3_path.stat().st_size > 95 * 1024 * 1024:
            raise RuntimeError("转换后的音频超过豆包 100MB 限制，请改用 Qwen")
        return {"data": base64.b64encode(mp3_path.read_bytes()).decode("ascii")}


def transcribe_doubao(message, api_key):
    endpoint = validate_endpoint(message.get("doubaoEndpoint"), "doubao")
    request_id = str(uuid.uuid4())
    body = {
        "user": {"uid": "xiaoyuzhou-desktop"},
        "audio": doubao_audio_input(message),
        "request": {
            "model_name": "bigmodel",
            "enable_itn": True,
            "enable_punc": True,
        },
    }
    payload, headers = request_json(
        endpoint,
        body,
        {
            "X-Api-Key": api_key,
            "X-Api-Resource-Id": str(
                message.get("doubaoResourceId") or "volc.bigasr.auc_turbo"
            ),
            "X-Api-Request-Id": request_id,
            "X-Api-Sequence": "-1",
        },
    )
    status = headers.get("X-Api-Status-Code", "")
    if status and status != "20000000":
        raise RuntimeError(
            f"豆包 ASR 失败（{status}）：{headers.get('X-Api-Message', '')}"
        )
    text = str((payload.get("result") or {}).get("text") or "").strip()
    if not text:
        raise RuntimeError(f"豆包 ASR 未返回文本：{json.dumps(payload, ensure_ascii=False)[:1000]}")
    return text


def transcribe_remote(message):
    transcript_directory = ensure_directory(message.get("transcriptDirectory"))
    credentials = load_credentials()
    provider = str(message.get("provider") or "qwen")
    if provider == "qwen":
        api_key = credentials.get("qwenApiKey")
        if not api_key:
            raise RuntimeError("请先在设置页配置 Qwen API Key")
        text = transcribe_qwen(message, api_key)
    elif provider == "doubao":
        api_key = credentials.get("doubaoApiKey")
        if not api_key:
            raise RuntimeError("请先在设置页配置豆包 API Key")
        text = transcribe_doubao(message, api_key)
    else:
        raise ValueError("不支持的 ASR Provider")

    base_name = safe_filename(message.get("baseName") or "transcript")
    destination = unique_path(transcript_directory, f"{base_name}.md")
    destination.write_text(
        markdown_transcript(base_name, text),
        encoding="utf-8",
    )
    return {"provider": provider, "markdown": str(destination)}


def handle_message(message):
    action = message.get("action")
    if action == "ping":
        credentials = load_credentials()
        return {
            "version": VERSION,
            "home": str(Path.home()),
            "defaultAudioPath": str(Path.home() / "Downloads" / "小宇宙音频"),
            "defaultTranscriptPath": str(Path.home() / "Downloads" / "小宇宙转写稿"),
            "qwenConfigured": bool(credentials.get("qwenApiKey")),
            "doubaoConfigured": bool(credentials.get("doubaoApiKey")),
        }
    if action == "save_asr_credentials":
        return save_asr_credentials(message.get("credentials") or {})
    if action == "choose_directory":
        return {"path": choose_directory(message.get("prompt"))}
    if action == "ensure_directories":
        paths = [str(ensure_directory(value)) for value in message.get("directories", [])]
        return {"paths": paths}
    if action == "download_audio":
        return download_audio(message)
    if action == "transcribe_remote":
        return transcribe_remote(message)
    raise ValueError("未知的本地助手操作")


def main():
    message = read_message()
    if message is None:
        return
    try:
        data = handle_message(message)
        write_message({"ok": True, "data": data})
    except Exception as error:
        write_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
