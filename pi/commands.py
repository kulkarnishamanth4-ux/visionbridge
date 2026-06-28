"""
commands.py — Voice command matching for VisionBridge
Ported from assistant.js — supports English, Hindi, and Kannada commands.
Uses fuzzy matching to handle accent variations.
"""
import logging
from voice import levenshtein

log = logging.getLogger("commands")


# ─── COMMAND DEFINITIONS ───
# Each command has: action name, list of trigger phrases
COMMANDS = {
    "scan": [
        # English
        "what do you see", "what's around", "what is around", "describe",
        "look around", "scan", "scene", "what's there", "tell me what you see",
        "check around", "what's in front", "what is in front",
        "where am i", "what's happening", "analyze",
        # Hindi
        "dekho", "dekhiye", "kya hai", "kya dikh raha", "batao",
        "aas paas kya hai", "samne kya hai", "dikhao",
        # Kannada
        "nodi", "nodri", "yenu ide", "heli", "yenu kanuttide",
    ],
    "read": [
        "read", "read this", "what does it say", "read the text",
        "read that sign", "what's written", "what is written",
        # Hindi
        "padho", "padh do", "kya likha hai", "kya likha",
        # Kannada
        "odi", "odu", "yenu baredide",
    ],
    "measure": [
        "measure", "how far", "how big", "how tall", "distance",
        "how close", "size", "dimensions", "how far is",
        # Hindi
        "kitna door", "kitna bada", "kitna paas", "naap",
        # Kannada
        "yeshtu doora", "yeshtu dodda",
    ],
    "sos": [
        "help", "help me", "emergency", "sos", "danger",
        "i need help", "i'm in danger", "save me", "please help",
        "call for help", "send help",
        # Hindi
        "bachao", "madad", "mujhe bachao", "madad karo",
        "khatarnak", "bachao mujhe",
        # Kannada
        "sahaya", "sahaya maadi", "ulisi", "kapadri",
    ],
    "stop": [
        "stop", "quiet", "shut up", "cancel", "enough", "silence",
        # Hindi
        "bas", "ruko", "chup", "band karo", "rok",
        # Kannada
        "nilsi", "nillsu", "saku", "saku maadi",
    ],
    "repeat": [
        "repeat", "say again", "come again", "once more", "what",
        "didn't hear", "say that again", "repeat that",
        # Hindi
        "phir se bolo", "dobara bolo", "fir se",
        # Kannada
        "matte heli", "innomme heli",
    ],
    "time": [
        "time", "what time", "what's the time", "current time",
        # Hindi
        "samay kya hai", "kitne baje", "time kya hai",
        # Kannada
        "samaya yeshtu", "time yeshtu",
    ],
    "date": [
        "date", "what's the date", "what day", "today's date",
        # Hindi
        "aaj kya date", "aaj kya taareekh", "kya din hai",
        # Kannada
        "indu yenu date", "indu yenu dinanka",
    ],
    "battery": [
        "battery", "power", "charge", "how much battery",
    ],
    "location": [
        "location", "where am i", "my location", "gps",
        # Hindi
        "kahan hun", "meri jagah", "kahan hun main",
        # Kannada
        "naanu yelli", "yelli iddini",
    ],
}

# Flatten for fuzzy matching
_ALL_KEYWORDS = {}
for action, phrases in COMMANDS.items():
    for phrase in phrases:
        for word in phrase.split():
            if len(word) >= 3:
                _ALL_KEYWORDS[word] = action


def classify_command(text):
    """
    Classify a voice command into an action.
    Returns (action, original_text) or ("ask", text) for questions.
    """
    if not text:
        return ("silence", "")

    text_lower = text.lower().strip()

    # ─── EXACT MATCH: check if any trigger phrase is in the text ───
    for action, phrases in COMMANDS.items():
        for phrase in phrases:
            if phrase in text_lower:
                log.info(f"Command matched: '{phrase}' → {action}")
                return (action, text)

    # ─── FUZZY MATCH: check individual words against known keywords ───
    words = text_lower.split()
    best_action = None
    best_score = float("inf")

    for word in words:
        if len(word) < 3:
            continue
        for keyword, action in _ALL_KEYWORDS.items():
            dist = levenshtein(word, keyword)
            threshold = max(1, int(len(keyword) * 0.3))
            if dist <= threshold and dist < best_score:
                best_score = dist
                best_action = action

    if best_action:
        log.info(f"Fuzzy command match: '{text}' → {best_action} (distance={best_score})")
        return (best_action, text)

    # ─── QUESTION DETECTION: if it sounds like a question, treat as ask ───
    question_starters = ["what", "where", "how", "who", "is", "are", "can", "do",
                         "kya", "kahan", "kaun", "kaise", "yenu", "yelli", "yaaru"]
    if any(text_lower.startswith(q) for q in question_starters) or "?" in text:
        log.info(f"Question detected: '{text}'")
        return ("ask", text)

    # Default: treat as a question about the scene
    log.info(f"No command match, treating as question: '{text}'")
    return ("ask", text)


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    test_phrases = [
        "what do you see",
        "dekho kya hai",
        "bachao mujhe",
        "how far is that car",
        "padh do yeh sign",
        "kitne baje hain",
        "nodi yen ide",
        "read that sign please",
        "help me I'm lost",
        "random gibberish words",
    ]

    for phrase in test_phrases:
        action, _ = classify_command(phrase)
        print(f"  '{phrase}' → {action}")
