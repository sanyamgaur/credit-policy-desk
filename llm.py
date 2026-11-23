"""Tiny Gemini client using only the Python standard library.

The key is read from the GEMINI_API_KEY environment variable, or from
.streamlit/secrets.toml (a local file that is never pushed to GitHub).

If a model is busy (503), rate-limited (429) or retired (404), the client waits,
retries, and then moves on to the next model in MODELS. Model names change
often: run `python3 llm.py` to see the ones your key can use.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest"]
SECRETS = Path(__file__).parent / ".streamlit" / "secrets.toml"
BASE = "https://generativelanguage.googleapis.com/v1beta/models"

last_model_used = None


def api_key():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key and SECRETS.exists():
        m = re.search(r'GEMINI_API_KEY\s*=\s*"([^"]+)"', SECRETS.read_text())
        key = m.group(1).strip() if m else ""
    return key


def available():
    return bool(api_key())


def models_to_try():
    chosen = os.environ.get("GEMINI_MODEL")
    return [chosen] if chosen else MODELS


def _call(model, body):
    req = urllib.request.Request(f"{BASE}/{model}:generateContent", data=body, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "x-goog-api-key": api_key()})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read())


def generate(prompt, json_mode=False, temperature=0.0):
    global last_model_used
    config = {"temperature": temperature}
    if json_mode:
        config["responseMimeType"] = "application/json"
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": config}).encode()
    errors = []
    for model in models_to_try():
        for wait in (0, 3, 8, 15):  # retry busy models with growing waits
            time.sleep(wait)
            try:
                data = _call(model, body)
                last_model_used = model
                return data["candidates"][0]["content"]["parts"][0]["text"]
            except urllib.error.HTTPError as e:
                msg = e.read().decode()[:200]
                errors.append(f"{model}: {e.code}")
                if e.code in (429, 500, 503):
                    continue          # busy: wait and retry the same model
                if e.code == 404:
                    break             # retired: try the next model
                raise RuntimeError(f"Gemini API error {e.code}: {msg}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                errors.append(f"{model}: {e}")
                continue
    raise RuntimeError("All models busy or unavailable. Try again in a few minutes. "
                       + "; ".join(errors[-4:]))


def list_models():
    """Names of the models this key can use for text generation."""
    req = urllib.request.Request(f"{BASE}?pageSize=1000", headers={"x-goog-api-key": api_key()})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return [m["name"].replace("models/", "") for m in data.get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])]


if __name__ == "__main__":
    names = list_models()
    print("Models your key can use:", ", ".join(n for n in names if "flash" in n))
    print("This project will try, in order:", ", ".join(models_to_try()))
