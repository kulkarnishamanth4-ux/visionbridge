"""
voice.py — Speech Recognition + Text-to-Speech for VisionBridge
Handles:
  - Continuous microphone listening
  - Wake word detection with fuzzy matching
  - Command capture with timeout
  - Spoken output via espeak (offline, instant)
"""
import speech_recognition as sr
import pyttsx3
import threading
import time
import logging

from config import (
    WAKE_WORD, WAKE_WORD_VARIANTS, LANGUAGE,
    COMMAND_TIMEOUT, WAKE_FUZZY_THRESHOLD
)

log = logging.getLogger("voice")


# ─── LEVENSHTEIN DISTANCE (ported from speech.js) ───
def levenshtein(a, b):
    """Calculate edit distance between two strings."""
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    matrix = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        matrix[i][0] = i
    for j in range(lb + 1):
        matrix[0][j] = j
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            matrix[i][j] = min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            )
    return matrix[la][lb]


def matches_wake_word(text):
    """Check if text matches the wake word using fuzzy matching."""
    text = text.lower().strip()

    # Direct substring check
    if WAKE_WORD in text:
        return True

    # Check known variants
    for variant in WAKE_WORD_VARIANTS:
        if variant in text:
            return True

    # Fuzzy match: check each 2-word window
    words = text.split()
    for i in range(len(words)):
        for length in range(1, min(4, len(words) - i + 1)):
            chunk = " ".join(words[i:i + length])
            dist = levenshtein(chunk, WAKE_WORD)
            threshold = int(len(WAKE_WORD) * WAKE_FUZZY_THRESHOLD)
            if dist <= threshold:
                return True

    return False


class VoiceEngine:
    """Handles all voice I/O — mic input and speaker output."""

    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.microphone = None
        self.tts_engine = None
        self.tts_lock = threading.Lock()
        self._speaking = False

        # Adjust for ambient noise on startup
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True
        self.recognizer.pause_threshold = 0.8

    def init(self):
        """Initialize microphone and TTS engine."""
        try:
            self.microphone = sr.Microphone()
            log.info("Microphone initialized")
        except Exception as e:
            log.error(f"Microphone init failed: {e}")
            log.info("Available mics: %s", sr.Microphone.list_microphone_names())
            raise

        try:
            self.tts_engine = pyttsx3.init()
            # Configure voice — use a clear, medium-speed voice
            self.tts_engine.setProperty("rate", 160)
            self.tts_engine.setProperty("volume", 1.0)
            # Try to find an English voice
            voices = self.tts_engine.getProperty("voices")
            for v in voices:
                if "english" in v.name.lower() or "en" in v.id.lower():
                    self.tts_engine.setProperty("voice", v.id)
                    break
            log.info("TTS engine initialized")
        except Exception as e:
            log.error(f"TTS init failed: {e}")
            raise

    def calibrate(self):
        """Calibrate mic for ambient noise (call once at startup)."""
        log.info("Calibrating microphone for ambient noise (2 seconds)...")
        try:
            with self.microphone as source:
                self.recognizer.adjust_for_ambient_noise(source, duration=2)
            log.info("Calibration done. Energy threshold: %.0f",
                     self.recognizer.energy_threshold)
        except Exception as e:
            log.warning(f"Calibration failed: {e}")

    def speak(self, text, block=True):
        """Speak text through earphones. Thread-safe."""
        if not text or not self.tts_engine:
            return
        log.info(f"Speaking: {text[:80]}...")
        self._speaking = True
        try:
            with self.tts_lock:
                self.tts_engine.say(text)
                self.tts_engine.runAndWait()
        except Exception as e:
            log.warning(f"TTS error: {e}")
        finally:
            self._speaking = False

    def is_speaking(self):
        return self._speaking

    def listen_for_wake_word(self, timeout=None):
        """
        Listen continuously until wake word is detected.
        Returns True when wake word heard, False on timeout/error.
        """
        log.debug("Listening for wake word...")
        try:
            with self.microphone as source:
                while True:
                    try:
                        audio = self.recognizer.listen(
                            source, timeout=timeout, phrase_time_limit=3
                        )
                        text = self._recognize(audio)
                        if text and matches_wake_word(text):
                            log.info(f"Wake word detected: '{text}'")
                            return True
                    except sr.WaitTimeoutError:
                        if timeout:
                            return False
                        continue
                    except sr.UnknownValueError:
                        continue
        except Exception as e:
            log.error(f"Wake word listener error: {e}")
            return False

    def listen_for_command(self, timeout=None):
        """
        Listen for a voice command after wake word.
        Returns the recognized text, or None on timeout/silence.
        """
        effective_timeout = timeout or COMMAND_TIMEOUT
        log.debug(f"Listening for command ({effective_timeout}s)...")
        try:
            with self.microphone as source:
                audio = self.recognizer.listen(
                    source, timeout=effective_timeout, phrase_time_limit=8
                )
                text = self._recognize(audio)
                if text:
                    log.info(f"Command heard: '{text}'")
                return text
        except sr.WaitTimeoutError:
            log.debug("Command listen timed out (silence)")
            return None
        except sr.UnknownValueError:
            log.debug("Could not understand command")
            return None
        except Exception as e:
            log.error(f"Command listen error: {e}")
            return None

    def _recognize(self, audio):
        """Send audio to Google Speech Recognition."""
        try:
            text = self.recognizer.recognize_google(audio, language=LANGUAGE)
            return text.strip() if text else None
        except sr.UnknownValueError:
            return None
        except sr.RequestError as e:
            log.warning(f"Speech API error: {e}")
            return None
