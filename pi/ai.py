"""
ai.py — Gemini AI interface for VisionBridge
Handles scene analysis, measurement, reading, and Q&A.
Calls Gemini API directly (no Node.js server needed).
"""
import logging
import time
import json
import re

from google import genai

from config import GEMINI_API_KEY, GEMINI_MODEL, GEMINI_FALLBACK

log = logging.getLogger("ai")

_client = None
_last_response_cache = {}


def init():
    """Initialize Gemini client."""
    global _client
    if not GEMINI_API_KEY or GEMINI_API_KEY == "YOUR_GEMINI_API_KEY_HERE":
        log.error("Gemini API key not set! Edit config.py")
        return False
    try:
        _client = genai.Client(api_key=GEMINI_API_KEY)
        log.info("Gemini AI client initialized")
        return True
    except Exception as e:
        log.error(f"Gemini init failed: {e}")
        return False


# ─── SYSTEM PROMPTS (same as server.js) ───

DETAILED_PROMPT = """You are VisionBridge, an AI assistant helping a blind person in India. Your descriptions are their EYES.

Respond with valid JSON only:
{"description": "rich spatial description", "dangers": [{"type": "vehicle|obstacle|stairs|animal|other", "severity": "critical|warning|info", "description": "brief with distance and direction", "direction": "left|right|ahead"}], "summary": "most important thing to know RIGHT NOW"}

RULES:
1. Use CLOCK DIRECTIONS: "at your 2 o'clock"
2. ESTIMATE DISTANCES: "about 3 meters ahead"
3. Describe WALKABLE PATH and GROUND CONDITIONS
4. Note OBSTACLES with size and position
5. INDIAN CONTEXT: stray dogs, cows, potholes, auto-rickshaws, open drains
6. If ANY danger exists, the summary MUST describe it
7. End with NAVIGATION ADVICE"""

DANGER_PROMPT = """You are VisionBridge in DANGER MODE. ONLY report immediate close-range dangers.

Respond with valid JSON:
{"description": "", "dangers": [{"type": "vehicle|obstacle|stairs|edge|animal", "severity": "critical|warning", "description": "5-10 words with distance", "direction": "left|right|ahead"}], "summary": "most urgent danger or 'No immediate dangers detected'"}

ONLY dangers within 5 meters. Be extremely concise."""

SUMMARY_PROMPT = """You are VisionBridge. Describe the entire scene in ONE sentence for a blind person.

Respond with valid JSON:
{"description": "", "dangers": [], "summary": "one sentence, max 30 words, covering environment, key objects, atmosphere"}"""

MEASURE_PROMPT = """You are VisionBridge in MEASURE MODE. Give ACCURATE measurements.

Respond with valid JSON:
{"objects": [{"name": "specific name", "size": "H x W in meters", "distance": "distance in meters", "moving": true/false, "speed": "km/h or stationary", "direction": "left|right|ahead|toward|away"}], "summary": "nearest object first, include exact distances"}

DISTANCE METHOD: Use known sizes (person=1.65m, car=1.5m tall, dog=0.45m) to calibrate.
Sort by distance, nearest first. Max 6 objects."""

READ_PROMPT = """You are VisionBridge. Read ALL text visible in this image.

Respond with valid JSON:
{"text": "exact text as written", "language": "detected language", "summary": "what the text says and what it means for the user"}

Read signs, labels, screens, papers, menus — EVERYTHING with text. If in Hindi/Kannada/other Indian language, transliterate AND translate to English."""

QA_PROMPT = """You are Vision, a helpful AI guide for a blind person. Answer their specific question about what the camera sees.

RULES:
1. Answer the SPECIFIC question directly
2. Use clock directions and distances
3. Keep it 2-3 sentences, natural and warm
4. Indian context: recognize Indian vehicles, signs, shops"""


def _extract_json(text):
    """Extract JSON from potentially markdown-wrapped response."""
    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code block
    match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try finding first { ... } block
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    return None


def _call_gemini(system_prompt, user_text, image_b64=None, max_tokens=1024):
    """Make a Gemini API call with fallback model."""
    if not _client:
        return None

    # Build parts
    parts = []
    if image_b64:
        # Strip data URI prefix
        raw_b64 = image_b64.split(",")[1] if "," in image_b64 else image_b64
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": raw_b64}})
    parts.append({"text": user_text})

    request_config = {
        "contents": [{"role": "user", "parts": parts}],
        "config": {
            "system_instruction": system_prompt,
            "temperature": 0.2,
            "max_output_tokens": max_tokens,
        }
    }

    # Try primary model, then fallback
    for model_name in [GEMINI_MODEL, GEMINI_FALLBACK]:
        try:
            response = _client.models.generate_content(
                model=model_name, **request_config
            )
            return response.text.strip()
        except Exception as e:
            log.warning(f"Gemini {model_name} failed: {e}")
            time.sleep(0.5)

    return None


def analyze_scene(image_b64, mode="detailed"):
    """Analyze a camera frame. Returns dict with description, dangers, summary."""
    prompts = {
        "detailed": (DETAILED_PROMPT, "Analyze this scene for a blind person. Describe surroundings in detail. JSON only."),
        "danger": (DANGER_PROMPT, "DANGER SCAN: Only report immediate close-range dangers. JSON only."),
        "summary": (SUMMARY_PROMPT, "Summarize this entire scene in ONE sentence. JSON only."),
        "measure": (MEASURE_PROMPT, "Estimate size, distance, and movement of all visible objects. JSON only."),
    }

    system, user_text = prompts.get(mode, prompts["detailed"])
    max_tokens = 256 if mode == "summary" else 512 if mode == "danger" else 1024

    text = _call_gemini(system, user_text, image_b64, max_tokens)
    if not text:
        # Return cache if available
        cached = _last_response_cache.get(mode)
        if cached:
            log.info("Returning cached response")
            return cached
        return {"description": "AI service unavailable. Try again.", "dangers": [], "summary": "Could not analyze scene."}

    parsed = _extract_json(text)
    if not parsed:
        parsed = {"description": text[:500], "dangers": [], "summary": text[:120]}

    if "dangers" not in parsed:
        parsed["dangers"] = []
    if "summary" not in parsed and "description" in parsed:
        parsed["summary"] = parsed["description"][:120]

    _last_response_cache[mode] = parsed
    return parsed


def measure_scene(image_b64):
    """Measure objects in the scene. Returns dict with objects list and summary."""
    text = _call_gemini(MEASURE_PROMPT,
        "Estimate size, distance, and movement of all visible objects. JSON only.",
        image_b64, 1200)

    if not text:
        cached = _last_response_cache.get("measure_obj")
        if cached:
            return cached
        return {"objects": [], "summary": "Measurement unavailable."}

    parsed = _extract_json(text) or {"objects": [], "summary": text[:200]}
    if "objects" not in parsed:
        parsed["objects"] = []
    _last_response_cache["measure_obj"] = parsed
    return parsed


def read_text(image_b64):
    """Read text from image. Returns dict with text, language, summary."""
    text = _call_gemini(READ_PROMPT,
        "Read ALL text visible in this image. JSON only.",
        image_b64, 800)

    if not text:
        return {"text": "", "summary": "Could not read text."}

    parsed = _extract_json(text) or {"text": text[:500], "summary": text[:120]}
    return parsed


def ask_question(image_b64, question):
    """Answer a specific question about the scene."""
    text = _call_gemini(QA_PROMPT, question, image_b64, 512)
    return text or "I couldn't process that right now."


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if init():
        print("✅ Gemini AI ready")
        # Test with a simple text query (no image)
        result = _call_gemini("You are a helpful assistant.", "Say hello in one sentence.")
        print(f"Test response: {result}")
    else:
        print("❌ Gemini init failed")
