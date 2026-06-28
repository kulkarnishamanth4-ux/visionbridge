"""
sensors.py — Hardware sensor interface for VisionBridge
Handles: HC-SR04 ultrasonic (x2), NEO-6M GPS, buzzer, tactile buttons.
All sensors run in background threads, main loop reads latest values.
"""
import threading
import time
import logging

log = logging.getLogger("sensors")

# GPIO will be imported only on Raspberry Pi
_gpio_available = False
try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    _gpio_available = True
except ImportError:
    log.warning("RPi.GPIO not available — running in simulation mode")

from config import (
    PIN_ULTRA_L_TRIG, PIN_ULTRA_L_ECHO,
    PIN_ULTRA_R_TRIG, PIN_ULTRA_R_ECHO,
    PIN_BUZZER, PIN_SOS_BUTTON, PIN_MODE_BUTTON,
    GPS_SERIAL_PORT, GPS_BAUD_RATE,
    ULTRA_DANGER_CM, ULTRA_WARNING_CM,
    ULTRA_POLL_INTERVAL, ULTRA_SMOOTHING,
)


class UltrasonicSensor:
    """HC-SR04 ultrasonic distance sensor."""

    def __init__(self, trig_pin, echo_pin, name="ultrasonic"):
        self.trig = trig_pin
        self.echo = echo_pin
        self.name = name
        self.distance_cm = -1
        self._readings = []

        if _gpio_available:
            GPIO.setup(self.trig, GPIO.OUT)
            GPIO.setup(self.echo, GPIO.IN)
            GPIO.output(self.trig, False)

    def read(self):
        """Take a single distance reading in cm. Returns -1 on error."""
        if not _gpio_available:
            return -1

        try:
            # Send 10µs pulse
            GPIO.output(self.trig, True)
            time.sleep(0.00001)
            GPIO.output(self.trig, False)

            # Wait for echo start (timeout after 50ms)
            start = time.time()
            timeout = start + 0.05
            while GPIO.input(self.echo) == 0:
                start = time.time()
                if start > timeout:
                    return -1

            # Wait for echo end
            end = time.time()
            timeout = end + 0.05
            while GPIO.input(self.echo) == 1:
                end = time.time()
                if end > timeout:
                    return -1

            # Calculate distance: speed of sound = 34300 cm/s
            duration = end - start
            distance = (duration * 34300) / 2

            # Valid range: 2cm to 400cm
            if 2 < distance < 400:
                # Smoothing: average last N readings
                self._readings.append(distance)
                if len(self._readings) > ULTRA_SMOOTHING:
                    self._readings.pop(0)
                self.distance_cm = sum(self._readings) / len(self._readings)
                return self.distance_cm

            return -1
        except Exception as e:
            log.debug(f"{self.name} read error: {e}")
            return -1


class GPS:
    """NEO-6M GPS module via UART serial."""

    def __init__(self):
        self.lat = None
        self.lng = None
        self.fix = False
        self._serial = None
        self._thread = None
        self._running = False

    def init(self):
        """Initialize GPS serial connection."""
        try:
            import serial
            self._serial = serial.Serial(
                GPS_SERIAL_PORT,
                baudrate=GPS_BAUD_RATE,
                timeout=1
            )
            log.info(f"GPS initialized on {GPS_SERIAL_PORT}")
            return True
        except Exception as e:
            log.warning(f"GPS init failed: {e} (GPS features disabled)")
            return False

    def start(self):
        """Start background GPS reading thread."""
        if not self._serial:
            return
        self._running = True
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self):
        """Continuously read and parse NMEA sentences."""
        while self._running and self._serial:
            try:
                line = self._serial.readline().decode("ascii", errors="ignore").strip()
                if line.startswith("$GPGGA") or line.startswith("$GPRMC"):
                    self._parse_nmea(line)
            except Exception:
                time.sleep(1)

    def _parse_nmea(self, sentence):
        """Parse GPGGA or GPRMC sentence for lat/lng."""
        try:
            parts = sentence.split(",")

            if sentence.startswith("$GPGGA") and len(parts) >= 6:
                if parts[2] and parts[4]:
                    self.lat = self._nmea_to_decimal(parts[2], parts[3])
                    self.lng = self._nmea_to_decimal(parts[4], parts[5])
                    self.fix = True

            elif sentence.startswith("$GPRMC") and len(parts) >= 6:
                if parts[3] and parts[5]:
                    self.lat = self._nmea_to_decimal(parts[3], parts[4])
                    self.lng = self._nmea_to_decimal(parts[5], parts[6])
                    self.fix = True

        except (ValueError, IndexError):
            pass

    def _nmea_to_decimal(self, value, direction):
        """Convert NMEA coordinate to decimal degrees."""
        if not value:
            return None
        # NMEA format: DDDMM.MMMM
        if "." in value:
            dot_pos = value.index(".")
            degrees = float(value[:dot_pos - 2])
            minutes = float(value[dot_pos - 2:])
            decimal = degrees + minutes / 60
            if direction in ("S", "W"):
                decimal = -decimal
            return round(decimal, 6)
        return None

    def get_location(self):
        """Get current GPS location. Returns (lat, lng) or (None, None)."""
        if self.fix and self.lat and self.lng:
            return (self.lat, self.lng)
        return (None, None)

    def stop(self):
        self._running = False
        if self._serial:
            self._serial.close()


class Buzzer:
    """Active buzzer for audio feedback."""

    def __init__(self):
        if _gpio_available:
            GPIO.setup(PIN_BUZZER, GPIO.OUT)
            GPIO.output(PIN_BUZZER, False)

    def beep(self, duration=0.15):
        """Single short beep."""
        if not _gpio_available:
            log.debug(f"[BUZZ] beep {duration}s")
            return
        GPIO.output(PIN_BUZZER, True)
        time.sleep(duration)
        GPIO.output(PIN_BUZZER, False)

    def double_beep(self):
        """Double beep (wake word confirmed)."""
        self.beep(0.1)
        time.sleep(0.08)
        self.beep(0.1)

    def danger_beep(self):
        """Rapid beeping pattern for danger."""
        for _ in range(5):
            self.beep(0.05)
            time.sleep(0.05)

    def sos_beep(self):
        """SOS pattern: ... --- ..."""
        for _ in range(3):
            self.beep(0.1)
            time.sleep(0.1)
        for _ in range(3):
            self.beep(0.3)
            time.sleep(0.1)
        for _ in range(3):
            self.beep(0.1)
            time.sleep(0.1)


class Buttons:
    """Tactile button handler with interrupt callbacks."""

    def __init__(self):
        self.sos_callback = None
        self.mode_callback = None

        if _gpio_available:
            GPIO.setup(PIN_SOS_BUTTON, GPIO.IN, pull_up_down=GPIO.PUD_UP)
            GPIO.setup(PIN_MODE_BUTTON, GPIO.IN, pull_up_down=GPIO.PUD_UP)

    def register(self, sos_callback=None, mode_callback=None):
        """Register button press callbacks."""
        self.sos_callback = sos_callback
        self.mode_callback = mode_callback

        if not _gpio_available:
            return

        if sos_callback:
            GPIO.add_event_detect(
                PIN_SOS_BUTTON, GPIO.FALLING,
                callback=lambda ch: sos_callback(),
                bouncetime=500
            )
            log.info("SOS button registered on GPIO %d", PIN_SOS_BUTTON)

        if mode_callback:
            GPIO.add_event_detect(
                PIN_MODE_BUTTON, GPIO.FALLING,
                callback=lambda ch: mode_callback(),
                bouncetime=500
            )
            log.info("Mode button registered on GPIO %d", PIN_MODE_BUTTON)


class ProximitySweep:
    """Continuous ultrasonic monitoring with buzzer feedback."""

    def __init__(self, left_sensor, right_sensor, buzzer):
        self.left = left_sensor
        self.right = right_sensor
        self.buzzer = buzzer
        self._running = False
        self._thread = None
        self.enabled = True

    def start(self):
        """Start background proximity monitoring."""
        self._running = True
        self._thread = threading.Thread(target=self._sweep_loop, daemon=True)
        self._thread.start()
        log.info("Proximity monitoring started")

    def _sweep_loop(self):
        while self._running:
            if not self.enabled:
                time.sleep(0.5)
                continue

            dl = self.left.read()
            dr = self.right.read()

            # Find closest reading
            closest = -1
            direction = ""
            if dl > 0 and dr > 0:
                if dl < dr:
                    closest, direction = dl, "left"
                else:
                    closest, direction = dr, "right"
            elif dl > 0:
                closest, direction = dl, "left"
            elif dr > 0:
                closest, direction = dr, "right"

            if closest > 0 and closest < ULTRA_DANGER_CM:
                self.buzzer.danger_beep()
                log.warning(f"PROXIMITY DANGER: {closest:.0f}cm to {direction}")
            elif closest > 0 and closest < ULTRA_WARNING_CM:
                self.buzzer.beep(0.05)

            time.sleep(ULTRA_POLL_INTERVAL)

    def get_distances(self):
        """Get current distances. Returns (left_cm, right_cm)."""
        return (self.left.distance_cm, self.right.distance_cm)

    def stop(self):
        self._running = False


def cleanup():
    """Release all GPIO resources."""
    if _gpio_available:
        GPIO.cleanup()
        log.info("GPIO cleaned up")


# ─── SELF-TEST ───
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("Testing sensors...")

    buzzer = Buzzer()
    print("Buzzer double beep:")
    buzzer.double_beep()

    left = UltrasonicSensor(PIN_ULTRA_L_TRIG, PIN_ULTRA_L_ECHO, "left")
    right = UltrasonicSensor(PIN_ULTRA_R_TRIG, PIN_ULTRA_R_ECHO, "right")

    print("Ultrasonic readings (5 seconds):")
    for _ in range(10):
        dl = left.read()
        dr = right.read()
        print(f"  Left: {dl:.1f}cm  |  Right: {dr:.1f}cm")
        time.sleep(0.5)

    gps = GPS()
    if gps.init():
        gps.start()
        print("GPS reading (10 seconds):")
        time.sleep(10)
        lat, lng = gps.get_location()
        print(f"  Location: {lat}, {lng}")
        gps.stop()

    cleanup()
