"""
sos.py — Multi-channel Emergency SOS for VisionBridge
Channels: Twilio Voice Call + SMS + Email (all fire simultaneously).
"""
import threading
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime

log = logging.getLogger("sos")

_twilio_client = None

from config import (
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
    SOS_CONTACT, SOS_CONTACT_TYPE,
    SOS_EMAIL_USER, SOS_EMAIL_PASS,
)


def init():
    """Initialize Twilio client if configured."""
    global _twilio_client
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER:
        try:
            from twilio.rest import Client
            _twilio_client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
            log.info("Twilio SOS initialized — voice call + SMS enabled")
            return True
        except Exception as e:
            log.warning(f"Twilio init failed: {e}")
    else:
        log.info("Twilio not configured — email-only SOS")
    return False


def _normalize_phone(number):
    """Normalize phone number to E.164 format (+91XXXXXXXXXX)."""
    cleaned = "".join(c for c in number if c.isdigit() or c == "+")
    if cleaned.startswith("0"):
        cleaned = cleaned[1:]
    if not cleaned.startswith("+"):
        if cleaned.startswith("91") and len(cleaned) > 11:
            cleaned = "+" + cleaned
        else:
            cleaned = "+91" + cleaned
    return cleaned


def trigger_sos(reason="Emergency", lat=None, lng=None, buzzer=None):
    """
    Fire all SOS channels simultaneously.
    Returns dict with results from each channel.
    """
    log.warning(f"🚨 SOS TRIGGERED: {reason}")

    # Buzzer feedback
    if buzzer:
        threading.Thread(target=buzzer.sos_beep, daemon=True).start()

    # Build location data
    maps_link = ""
    loc_text = "Location unavailable"
    if lat and lng:
        maps_link = f"https://maps.google.com/?q={lat},{lng}"
        loc_text = f"Lat: {lat}, Lng: {lng}"

    time_str = datetime.now().strftime("%I:%M %p, %d %B %Y")

    results = {"call": None, "sms": None, "email": None}

    # Fire all channels in parallel threads
    threads = []

    # Channel 1: Twilio Voice Call
    if _twilio_client and SOS_CONTACT_TYPE == "phone":
        t = threading.Thread(
            target=_send_call,
            args=(reason, loc_text, time_str, results),
            daemon=True
        )
        threads.append(t)
        t.start()

    # Channel 2: Twilio SMS
    if _twilio_client and SOS_CONTACT_TYPE == "phone":
        t = threading.Thread(
            target=_send_sms,
            args=(reason, loc_text, maps_link, time_str, results),
            daemon=True
        )
        threads.append(t)
        t.start()

    # Channel 3: Email
    if SOS_EMAIL_USER and SOS_EMAIL_PASS and "@" in SOS_CONTACT:
        t = threading.Thread(
            target=_send_email,
            args=(reason, loc_text, maps_link, time_str, results),
            daemon=True
        )
        threads.append(t)
        t.start()

    # Wait for all channels (max 15 seconds)
    for t in threads:
        t.join(timeout=15)

    # Summary
    success_channels = [k for k, v in results.items() if v and v.get("success")]
    log.info(f"SOS channels fired: {success_channels or 'none'}")

    return {
        "success": len(success_channels) > 0,
        "channels": results,
        "summary": f"SOS sent via: {', '.join(success_channels)}" if success_channels
                   else "All SOS channels failed.",
    }


def _send_call(reason, loc_text, time_str, results):
    """Make Twilio voice call with inline TwiML."""
    try:
        to_number = _normalize_phone(SOS_CONTACT)
        twiml = (
            f'<Response>'
            f'<Pause length="1"/>'
            f'<Say voice="Polly.Aditi" language="en-IN">'
            f'Emergency alert from Vision Bridge. {reason}. '
            f'{loc_text}. Time: {time_str}. '
            f'Please respond immediately. This is an automated emergency call.'
            f'</Say>'
            f'<Pause length="2"/>'
            f'<Say voice="Polly.Aditi" language="en-IN">'
            f'Repeating: Emergency alert. {loc_text}. '
            f'Please check your SMS for the Google Maps location link.'
            f'</Say>'
            f'</Response>'
        )

        call = _twilio_client.calls.create(
            twiml=twiml,
            to=to_number,
            from_=TWILIO_PHONE_NUMBER,
            timeout=30
        )
        log.info(f"✅ Voice call initiated to {to_number} (SID: {call.sid})")
        results["call"] = {"success": True, "sid": call.sid}
    except Exception as e:
        log.error(f"❌ Voice call failed: {e}")
        results["call"] = {"success": False, "error": str(e)}


def _send_sms(reason, loc_text, maps_link, time_str, results):
    """Send Twilio SMS."""
    try:
        to_number = _normalize_phone(SOS_CONTACT)
        body = (
            f"🚨 VISIONBRIDGE SOS 🚨\n"
            f"Reason: {reason}\n"
            f"Location: {loc_text}\n"
            f"{'📍 Maps: ' + maps_link if maps_link else ''}\n"
            f"Time: {time_str}\n"
            f"Reply or call back immediately."
        )

        msg = _twilio_client.messages.create(
            body=body,
            to=to_number,
            from_=TWILIO_PHONE_NUMBER
        )
        log.info(f"✅ SMS sent to {to_number} (SID: {msg.sid})")
        results["sms"] = {"success": True, "sid": msg.sid}
    except Exception as e:
        log.error(f"❌ SMS failed: {e}")
        results["sms"] = {"success": False, "error": str(e)}


def _send_email(reason, loc_text, maps_link, time_str, results):
    """Send emergency email via Gmail SMTP."""
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "🚨 EMERGENCY SOS - VisionBridge Alert"
        msg["From"] = f"VisionBridge SOS <{SOS_EMAIL_USER}>"
        msg["To"] = SOS_CONTACT

        text_body = (
            f"EMERGENCY SOS\n"
            f"Reason: {reason}\n"
            f"Location: {loc_text}\n"
            f"{'Maps: ' + maps_link if maps_link else ''}\n"
            f"Time: {time_str}"
        )

        html_body = f"""
        <div style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;border:3px solid #e74c3c;border-radius:12px;">
            <h1 style="color:#e74c3c;text-align:center;">🚨 EMERGENCY SOS</h1>
            <p style="font-size:18px;">A VisionBridge user needs immediate help.</p>
            <hr>
            <p><strong>Reason:</strong> {reason}</p>
            <p><strong>Location:</strong> {loc_text}</p>
            {'<p><a href="' + maps_link + '" style="display:inline-block;padding:12px 24px;background:#e74c3c;color:#fff;text-decoration:none;border-radius:8px;">📍 Open in Google Maps</a></p>' if maps_link else ''}
            <p><strong>Time:</strong> {time_str}</p>
        </div>
        """

        msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(SOS_EMAIL_USER, SOS_EMAIL_PASS)
            server.sendmail(SOS_EMAIL_USER, SOS_CONTACT, msg.as_string())

        log.info(f"✅ Email sent to {SOS_CONTACT}")
        results["email"] = {"success": True}
    except Exception as e:
        log.error(f"❌ Email failed: {e}")
        results["email"] = {"success": False, "error": str(e)}


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    init()
    print("Triggering test SOS...")
    result = trigger_sos(reason="Test SOS from Pi", lat=12.9716, lng=77.5946)
    print(f"Result: {result}")
