"""VISION AI — Flask backend with secure Groq Vision API integration."""

from __future__ import annotations

import base64
import binascii
import os
import re
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory
from groq import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    BadRequestError,
    Groq,
    RateLimitError,
)
from werkzeug.exceptions import RequestEntityTooLarge

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB decoded limit
MIN_IMAGE_BYTES = 100
MAX_QUESTION_CHARS = 500
MAX_HISTORY_TURNS = 4
GROQ_TIMEOUT_SECONDS = 25.0
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 30

ALLOWED_STATIC_FILES = {
    "index.html",
    "style.css",
    "camera.js",
    "voice.js",
    "assistant.js",
    "script.js",
}

SUPPORTED_LANGUAGES = {
    "en-US": "English",
    "hi-IN": "Hindi",
    "es-ES": "Spanish",
    "fr-FR": "French",
    "de-DE": "German",
    "ar-SA": "Arabic",
    "zh-CN": "Chinese (Simplified)",
    "ja-JP": "Japanese",
    "pt-BR": "Portuguese",
    "ru-RU": "Russian",
    "bn-IN": "Bengali",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
}

ALLOWED_MODES = {"initial", "question", "continuous"}
DATA_URL_PATTERN = re.compile(
    r"^data:(image/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024  # 6 MB JSON payload limit

_rate_lock = threading.Lock()
_rate_buckets: dict[str, deque[float]] = {}


def get_vision_model() -> str:
    """Return configured Groq vision model or the supported default."""
    configured = os.environ.get("GROQ_VISION_MODEL", "").strip()
    return configured or DEFAULT_VISION_MODEL


def get_client_identifier() -> str:
    """Resolve client IP address safely behind proxies such as Render."""
    forwarded_for = request.headers.get("X-Forwarded-For", "").strip()
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or "unknown"


def check_rate_limit(client_id: str) -> tuple[bool, int]:
    """Check sliding-window rate limit for a client identifier."""
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with _rate_lock:
        bucket = _rate_buckets.setdefault(client_id, deque())
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
            retry_after = max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - bucket[0])))
            return False, retry_after
        bucket.append(now)
    return True, 0


def validate_image_data_url(image_input: Any) -> tuple[str | None, str | None]:
    """Validate base64 image data URI and verify binary image headers."""
    if not isinstance(image_input, str):
        return None, "Image field must be a base64 data URL string."

    cleaned = image_input.strip()
    if not cleaned:
        return None, "Image data is empty."

    match = DATA_URL_PATTERN.match(cleaned)
    if not match:
        return None, (
            "Invalid image format. Expected a base64 data URL for JPEG, PNG, or WebP."
        )

    mime_type = match.group(1).lower()
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"

    raw_b64 = re.sub(r"\s+", "", match.group(2))
    try:
        decoded = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        return None, "Image data contains invalid base64 encoding."

    byte_len = len(decoded)
    if byte_len < MIN_IMAGE_BYTES:
        return None, "Image payload is too small to be a valid camera frame."
    if byte_len > MAX_IMAGE_BYTES:
        return None, f"Image exceeds maximum allowed size of {MAX_IMAGE_BYTES // (1024 * 1024)} MB."

    is_jpeg = mime_type == "image/jpeg" and decoded.startswith(b"\xff\xd8\xff")
    is_png = mime_type == "image/png" and decoded.startswith(b"\x89PNG\r\n\x1a\n")
    is_webp = (
        mime_type == "image/webp"
        and len(decoded) >= 12
        and decoded[:4] == b"RIFF"
        and decoded[8:12] == b"WEBP"
    )
    if not (is_jpeg or is_png or is_webp):
        return None, "Image bytes do not match a valid JPEG, PNG, or WebP file."

    normalized_b64 = base64.b64encode(decoded).decode("ascii")
    return f"data:{mime_type};base64,{normalized_b64}", None


def sanitize_history(raw_history: Any) -> list[dict[str, str]]:
    """Sanitize recent conversation history turns."""
    if not isinstance(raw_history, list):
        return []
    sanitized: list[dict[str, str]] = []
    for item in raw_history[-MAX_HISTORY_TURNS:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        text = item.get("text")
        if role in {"user", "assistant"} and isinstance(text, str):
            trimmed = text.strip()[:300]
            if trimmed:
                sanitized.append({"role": role, "text": trimmed})
    return sanitized


def resolve_language_name(lang_code: Any) -> tuple[str, str]:
    """Map language code to a clean BCP-47 tag and human-readable language name."""
    if isinstance(lang_code, str):
        candidate = lang_code.strip()
        if candidate in SUPPORTED_LANGUAGES:
            return candidate, SUPPORTED_LANGUAGES[candidate]
        if re.fullmatch(r"[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?", candidate):
            return candidate, candidate
    return "en-US", "English"


def build_system_prompt(language_name: str, mode: str) -> str:
    """Construct the safety-first accessibility system prompt for Groq Vision."""
    mode_guidance = {
        "initial": (
            "This is the initial scene scan when the user started the assistant. "
            "Briefly summarize the main environment, people or large objects ahead, "
            "and their general position (left, center, right)."
        ),
        "continuous": (
            "This is a periodic surroundings update. Briefly note what is currently in view, "
            "focusing on notable objects, people, doorways, or potential visual changes."
        ),
        "question": (
            "Answer the user's specific question directly using only what is clearly visible "
            "in the current camera frame."
        ),
    }[mode]

    return (
        "You are VISION AI, a voice-first visual assistant helping a blind or low-vision user "
        "understand their surroundings from a live camera image.\n\n"
        f"RESPONSE LANGUAGE: Respond naturally in {language_name}.\n"
        f"TASK CONTEXT: {mode_guidance}\n\n"
        "ACCESSIBILITY STYLE RULES:\n"
        "- Speak concisely in 1 to 3 clear sentences suitable for text-to-speech.\n"
        "- Do not use markdown formatting, asterisks, bullet symbols, or emojis.\n"
        "- Use spatial orientation from the camera's perspective (left, center, right, foreground, background).\n"
        "- Mention clearly legible text or signs only if relevant to the user's question or orientation.\n\n"
        "MANDATORY SAFETY RULES:\n"
        "- You are an informational assistant, NOT a certified mobility or navigation system.\n"
        "- NEVER guarantee that a path is safe, clear, or free of obstacles.\n"
        "- NEVER tell or encourage the user to walk forward, step, or cross a street or road.\n"
        "- NEVER claim exact distances; use cautious phrasing like 'appears nearby', 'seems a few steps ahead', or 'cannot see the ground below the frame'.\n"
        "- If the image is blurry, too dark, overexposed, or partially blocked, state that clearly instead of guessing."
    )


@app.errorhandler(RequestEntityTooLarge)
def handle_payload_too_large(_err: RequestEntityTooLarge) -> tuple[Response, int]:
    return (
        jsonify(
            {
                "ok": False,
                "error": "Request payload is too large. Please reduce camera resolution and retry.",
                "code": "PAYLOAD_TOO_LARGE",
            }
        ),
        413,
    )


@app.get("/")
def serve_index() -> Response:
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:filename>")
def serve_root_asset(filename: str) -> tuple[Response, int] | Response:
    if filename not in ALLOWED_STATIC_FILES:
        return jsonify({"ok": False, "error": "Resource not found."}), 404
    file_path = BASE_DIR / filename
    if not file_path.is_file():
        return jsonify({"ok": False, "error": "Resource not found."}), 404
    return send_from_directory(BASE_DIR, filename)


@app.get("/health")
def health_check() -> tuple[Response, int]:
    api_key_present = bool(os.environ.get("GROQ_API_KEY", "").strip())
    return (
        jsonify(
            {
                "ok": True,
                "status": "healthy" if api_key_present else "degraded_missing_api_key",
                "groq_configured": api_key_present,
                "model": get_vision_model(),
                "max_image_bytes": MAX_IMAGE_BYTES,
                "supported_languages": list(SUPPORTED_LANGUAGES.keys()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        ),
        200,
    )


@app.post("/api/vision")
def analyze_vision() -> tuple[Response, int]:
    client_id = get_client_identifier()
    allowed, retry_after = check_rate_limit(client_id)
    if not allowed:
        response = jsonify(
            {
                "ok": False,
                "error": f"Too many analysis requests. Please wait {retry_after} seconds and try again.",
                "code": "RATE_LIMITED",
            }
        )
        response.headers["Retry-After"] = str(retry_after)
        return response, 429

    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": (
                        "Server configuration error: GROQ_API_KEY is not set. "
                        "Configure GROQ_API_KEY in your environment variables."
                    ),
                    "code": "MISSING_API_KEY",
                }
            ),
            503,
        )

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Invalid JSON request body.",
                    "code": "INVALID_JSON",
                }
            ),
            400,
        )

    validated_image, image_error = validate_image_data_url(payload.get("image"))
    if image_error or not validated_image:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": image_error or "Invalid image payload.",
                    "code": "INVALID_IMAGE",
                }
            ),
            400,
        )

    mode = payload.get("mode", "question")
    if not isinstance(mode, str) or mode not in ALLOWED_MODES:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Invalid analysis mode. Expected 'initial', 'question', or 'continuous'.",
                    "code": "INVALID_MODE",
                }
            ),
            400,
        )

    raw_question = payload.get("question", "")
    if raw_question is None:
        raw_question = ""
    if not isinstance(raw_question, str):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Question must be a text string.",
                    "code": "INVALID_QUESTION",
                }
            ),
            400,
        )

    question = raw_question.strip()
    if len(question) > MAX_QUESTION_CHARS:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": f"Question exceeds maximum length of {MAX_QUESTION_CHARS} characters.",
                    "code": "QUESTION_TOO_LONG",
                }
            ),
            400,
        )

    if not question:
        if mode == "initial":
            question = "Describe what is currently in front of the camera for initial orientation."
        elif mode == "continuous":
            question = "Give a brief update on what is currently visible in front of the camera."
        else:
            question = "What is in front of me?"

    language_code, language_name = resolve_language_name(payload.get("language"))
    history = sanitize_history(payload.get("history"))
    model_name = get_vision_model()

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": build_system_prompt(language_name=language_name, mode=mode),
        }
    ]

    for turn in history:
        messages.append({"role": turn["role"], "content": turn["text"]})

    messages.append(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": question},
                {"type": "image_url", "image_url": {"url": validated_image}},
            ],
        }
    )

    try:
        client = Groq(
            api_key=api_key,
            timeout=GROQ_TIMEOUT_SECONDS,
            max_retries=1,
        )
        completion = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.3,
            max_completion_tokens=240,
        )
    except APITimeoutError:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "The AI vision service timed out. Please try again.",
                    "code": "GROQ_TIMEOUT",
                }
            ),
            504,
        )
    except AuthenticationError:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Groq API authentication failed. Verify GROQ_API_KEY on the server.",
                    "code": "GROQ_AUTH_ERROR",
                }
            ),
            502,
        )
    except RateLimitError:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Groq API rate limit reached. Pausing briefly before retrying.",
                    "code": "GROQ_RATE_LIMIT",
                }
            ),
            429,
        )
    except BadRequestError as exc:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": (
                        f"Groq rejected the request for model '{model_name}'. "
                        f"Check GROQ_VISION_MODEL configuration. Details: {str(exc)[:200]}"
                    ),
                    "code": "GROQ_BAD_REQUEST",
                }
            ),
            400,
        )
    except (APIConnectionError, APIStatusError) as exc:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": f"Groq API connection error: {str(exc)[:200]}",
                    "code": "GROQ_API_ERROR",
                }
            ),
            502,
        )
    except Exception as exc:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": f"Unexpected server error during vision analysis: {str(exc)[:200]}",
                    "code": "INTERNAL_ERROR",
                }
            ),
            500,
        )

    answer = ""
    try:
        choices = getattr(completion, "choices", None) or []
        if choices:
            content = choices[0].message.content
            if isinstance(content, str):
                answer = content.strip()
    except Exception:
        answer = ""

    if not answer:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "The AI vision model returned an empty or unreadable response.",
                    "code": "EMPTY_MODEL_RESPONSE",
                }
            ),
            502,
        )

    return (
        jsonify(
            {
                "ok": True,
                "answer": answer,
                "model": model_name,
                "language": language_code,
                "mode": mode,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        ),
        200,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
