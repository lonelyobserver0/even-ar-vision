# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper", "fastapi", "uvicorn", "python-multipart"]
# ///
"""
Local, privacy-first ASR server for AR Vision voice chat.

Exposes an OpenAI-compatible endpoint:

    POST /v1/audio/transcriptions   (multipart: file=<wav>, model=<ignored>)
    ->  {"text": "..."}

Everything runs on this machine — the audio never leaves the LAN. Whisper weights
are downloaded once (from Hugging Face) on first run; inference is fully local.

Run (no manual install needed, uv resolves the inline deps):

    uv run asr/server.py                      # defaults: model=small, port 8000, all interfaces
    WHISPER_MODEL=base WHISPER_PORT=8000 uv run asr/server.py

Then point the app's "Whisper (ASR) URL" at  http://<this-pc-ip>:<port>/v1/audio/transcriptions

CORS is wide-open (Access-Control-Allow-Origin: *) so the brain's WebView (served from
http://localhost) can call it cross-origin — same requirement we hit with LM Studio.
"""
import os
import tempfile

from fastapi import FastAPI, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")  # int8 is fast+light on CPU
PORT = int(os.environ.get("WHISPER_PORT", "8000"))
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "")  # "" = auto-detect

app = FastAPI(title="AR Vision local ASR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

print(f"Loading faster-whisper '{MODEL_NAME}' ({DEVICE}/{COMPUTE})…")
whisper_model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
print("Model ready.")


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile, model: str = Form(default="whisper-1")):  # noqa: ARG001
    audio = await file.read()
    # faster-whisper reads file paths or file-like objects; a temp file is the safe path.
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        tmp.write(audio)
        tmp.flush()
        segments, _info = whisper_model.transcribe(
            tmp.name,
            language=LANGUAGE or None,
            vad_filter=True,  # drop leading/trailing silence
        )
        text = "".join(seg.text for seg in segments).strip()
    return {"text": text}


@app.get("/")
def health():
    return {"ok": True, "model": MODEL_NAME}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
