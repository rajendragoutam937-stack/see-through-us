# VISION AI

**VISION AI** is a voice-first AI visual assistant web application built to help blind and low-vision users understand their surroundings through live camera analysis, natural voice questions, typed questions, and spoken responses.

> **Important Safety Notice:** VISION AI is an informational assistant, **not** a certified mobility aid, cane replacement, guide dog replacement, or navigation device. It must never be relied upon to guarantee that a path is safe, that no obstacles exist, that exact distances are accurate, or that crossing a street or road is safe.

---

## Key Features

- **Single Prominent Control (`START ASSISTANT`)**: Requests camera and microphone permissions, starts the live camera feed, activates voice recognition, captures an initial image, analyzes it with Groq Vision, and speaks the description aloud.
- **Real Groq Vision Backend (`app.py`)**: Sends camera frames and user questions securely from the Flask server to the Groq API (`GROQ_API_KEY` is never exposed to the browser).
- **Natural Voice & Text Conversation**:
  - Uses browser `SpeechRecognition` and `speechSynthesis` APIs.
  - Supports interrupting speech at any time (`Stop Speaking`, `Escape`, or typing a question).
  - Pauses microphone recognition while speaking to avoid talking over the user or transcribing itself, then automatically resumes listening.
  - Supports typed questions and quick-ask buttons as an accessible alternative.
- **Continuous Visual Awareness**: Periodically captures and analyzes the latest camera frame every 12 seconds when idle, prevents overlapping requests, pauses automatically when toggled off or when consecutive API errors occur, and never fabricates results.
- **Multilingual Support**: Includes English, Hindi, Spanish, French, German, Arabic, Chinese (Mandarin), Japanese, Portuguese, Russian, Bengali, Tamil, and Telugu, with an extensible `SUPPORTED_LANGUAGES` registry in `voice.js` and `app.py`.
- **High-Contrast Accessible UI**: Built with `Atkinson Hyperlegible` typography, high-contrast color tokens, large touch targets, `aria-live` announcements, and keyboard shortcuts (`Alt+S`, `Alt+A`, `Escape`, `Enter`).

---

## Flat Project Structure

Every source file sits directly in the root directory with no nested folders:

1. `index.html` — Semantic, screen-reader-friendly interface
2. `style.css` — High-contrast, responsive accessible styling
3. `camera.js` — Camera permissions, rear-camera selection, camera switching, and JPEG frame capture
4. `voice.js` — Microphone permissions, multilingual speech recognition, speech synthesis, and interruption handling
5. `assistant.js` — Core orchestration, initial scan, question prioritization, and continuous visual awareness loop
6. `script.js` — DOM wiring, keyboard shortcuts, settings persistence, and `/health` check
7. `app.py` — Flask server, static asset allowlist, `/health`, `/api/vision`, rate limiting, and Groq API integration
8. `requirements.txt` — Python dependencies for local runs and Render deployment
9. `README.md` — Setup, Render deployment, environment variables, testing, and troubleshooting

---

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Yes | — | Your Groq API key used strictly on the Flask backend. |
| `GROQ_VISION_MODEL` | No | `meta-llama/llama-4-scout-17b-16e-instruct` | Configurable Groq vision model ID. |
| `PORT` | No | `5000` | Port used when running `python app.py` directly (Render sets `PORT` automatically). |

### Changing the Vision Model

By default, VISION AI uses `meta-llama/llama-4-scout-17b-16e-instruct`. To switch to another supported Groq vision model (for example `meta-llama/llama-4-maverick-17b-128e-instruct` or `qwen/qwen3.8-27b`), set the `GROQ_VISION_MODEL` environment variable:

```bash
export GROQ_VISION_MODEL="meta-llama/llama-4-scout-17b-16e-instruct"
```

Verify current supported vision model IDs in your Groq Console before changing this variable.

---

## Local Setup & Running

1. Create and activate a Python 3.11+ virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
3. Set your Groq API key:
   ```bash
   export GROQ_API_KEY="your_actual_groq_api_key"
   ```
4. Start the Flask development server or Gunicorn:
   ```bash
   python app.py
   ```
   Or with Gunicorn:
   ```bash
   gunicorn app:app
   ```
5. Open `http://localhost:5000` (or `https://` in production — browsers require HTTPS or `localhost` for camera and microphone permissions).

---

## Deploying to Render

1. Push all 9 root files to a GitHub repository.
2. In the **Render Dashboard**, click **New +** -> **Web Service** and connect your repository.
3. Configure the service settings:
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
4. Open the **Environment** tab in your Render service and add:
   - Key: `GROQ_API_KEY` | Value: `your_actual_groq_api_key`
   - *(Optional)* Key: `GROQ_VISION_MODEL` | Value: `meta-llama/llama-4-scout-17b-16e-instruct`
5. Click **Create Web Service** (or **Manual Deploy** -> **Deploy latest commit**).
6. Once deployed, Render serves the app over **HTTPS**, which enables browser camera and microphone permissions on mobile and desktop.

---

## Multilingual & Browser Voice Support

- Available speech recognition (`SpeechRecognition` / `webkitSpeechRecognition`) languages and text-to-speech (`speechSynthesis`) voices **depend on the user's browser and operating system**.
- Chromium-based browsers (Google Chrome, Microsoft Edge, Android Chrome) generally provide the broadest support for continuous speech recognition across languages.
- Even if a browser lacks a local voice or speech recognition engine for a selected language, VISION AI still accepts typed questions and instructs the Groq vision model to respond in the selected language.
- To add another language, append an entry to `SUPPORTED_LANGUAGES` in `voice.js` and `SUPPORTED_LANGUAGES` in `app.py`.

---

## Testing Summary & Known Limitations

### Verified Checks
- **Python syntax**: Verified `app.py` with `python3 -m py_compile app.py`.
- **JavaScript syntax**: Verified `camera.js`, `voice.js`, `assistant.js`, and `script.js` with `node --check`.
- **Backend validation logic**: Verified `validate_image_data_url` (magic-byte JPEG/PNG/WebP checks and size rejection), `resolve_language_name`, `build_system_prompt` safety rules, and `check_rate_limit` sliding-window enforcement in Python 3.11.
- **HTTP endpoints & static files**: Verified serving of `index.html`, `style.css`, `camera.js`, `voice.js`, `assistant.js`, `script.js`, `/health`, and `503 MISSING_API_KEY` error response on `/api/vision` when `GROQ_API_KEY` is unset.

### Known Limitations & Untested Runtime Dependencies
- **Live Groq Vision Inference**: Could not be executed against live Groq servers during build verification when `GROQ_API_KEY` is not set in the sandbox environment.
- **Gunicorn / Flask Wheel Execution**: The build sandbox uses Python 3.11 stdlib without `pip` installed; full `pip install -r requirements.txt` and `gunicorn app:app` execution should be verified in your local Python environment or on Render.
- **Hardware Camera & Microphone Permissions**: Live browser `getUserMedia` and Web Speech API recognition/synthesis require an interactive browser session with physical camera/microphone hardware over HTTPS or `localhost`.
- **In-Memory Rate Limiting**: `app.py` uses an in-memory per-process sliding window (`30` requests/minute per client IP). In multi-worker Gunicorn deployments, each worker maintains its own bucket.

---

## Troubleshooting

- **Camera permission denied**: Open your browser site permissions (lock icon in the address bar), set Camera to **Allow**, and click **START ASSISTANT** again. On non-localhost URLs, ensure you are using `https://`.
- **Microphone not working or unsupported**: Firefox and some iOS webviews do not support `SpeechRecognition`. Use Chrome/Edge/Safari where supported, or type questions directly into the **Ask a Question** input box.
- **"GROQ_API_KEY is not set" warning**: Add `GROQ_API_KEY` in your Render Environment Variables (or local shell) and restart/redeploy the server.
- **Spoken responses are silent**: Check the in-app **Speech Volume** slider, confirm your device volume is up, and ensure your browser tab is not muted.
- **Groq model errors (`400` or `404`)**: Confirm `GROQ_VISION_MODEL` matches an active vision-capable model in your Groq account.
