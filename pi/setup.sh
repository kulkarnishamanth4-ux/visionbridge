#!/bin/bash
# ─────────────────────────────────────────────
#  VisionBridge Pi — One-Command Setup Script
#  Run this on a fresh Raspberry Pi OS Lite:
#    chmod +x setup.sh && ./setup.sh
# ─────────────────────────────────────────────
set -e

echo "╔══════════════════════════════════════╗"
echo "║   VisionBridge Pi Setup              ║"
echo "║   Raspberry Pi 3B+ / 1GB            ║"
echo "╚══════════════════════════════════════╝"

# Update system
echo "[1/8] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# Install system dependencies
echo "[2/8] Installing system dependencies..."
sudo apt-get install -y \
    python3-pip python3-venv python3-dev \
    python3-picamera2 \
    libportaudio2 portaudio19-dev \
    espeak espeak-data \
    flac \
    libatlas-base-dev \
    git

# Enable camera interface
echo "[3/8] Enabling camera interface..."
sudo raspi-config nonint do_camera 0 2>/dev/null || true

# Enable serial (UART) for GPS — disable serial console
echo "[4/8] Enabling serial for GPS..."
sudo raspi-config nonint do_serial_hw 0 2>/dev/null || true
sudo raspi-config nonint do_serial_cons 1 2>/dev/null || true

# Configure audio output to 3.5mm jack
echo "[5/8] Setting audio output to 3.5mm jack..."
sudo raspi-config nonint do_audio 1 2>/dev/null || true
# Also set ALSA default
amixer cset numid=3 1 2>/dev/null || true

# Install Python packages
echo "[6/8] Installing Python packages..."
cd "$(dirname "$0")"
pip3 install --break-system-packages -r requirements.txt 2>/dev/null || \
    pip3 install -r requirements.txt

# Download TFLite model (COCO-SSD MobileNet v1 quantized, ~4MB)
echo "[7/8] Downloading object detection model..."
mkdir -p models
if [ ! -f models/coco_ssd_mobilenet_v2.tflite ]; then
    echo "  Downloading COCO-SSD MobileNet model..."
    wget -q -O /tmp/coco_ssd.zip \
        "https://storage.googleapis.com/download.tensorflow.org/models/tflite/coco_ssd_mobilenet_v1_1.0_quant_2018_06_29.zip"
    if [ -f /tmp/coco_ssd.zip ]; then
        unzip -o /tmp/coco_ssd.zip -d /tmp/coco_ssd/ 2>/dev/null
        # Find the .tflite file and copy it
        find /tmp/coco_ssd/ -name "*.tflite" -exec cp {} models/coco_ssd_mobilenet_v2.tflite \; 2>/dev/null
        rm -rf /tmp/coco_ssd.zip /tmp/coco_ssd/
        if [ -f models/coco_ssd_mobilenet_v2.tflite ]; then
            echo "  ✅ Model downloaded successfully"
        else
            echo "  ⚠️  Model extraction failed. Download manually."
        fi
    else
        echo "  ⚠️  Download failed. Check internet connection."
    fi
else
    echo "  Model already exists, skipping."
fi

# Install tflite-runtime (lightweight, no full TensorFlow needed)
echo "  Installing TFLite runtime..."
pip3 install --break-system-packages tflite-runtime 2>/dev/null || \
    pip3 install tflite-runtime 2>/dev/null || \
    echo "  ⚠️  tflite-runtime install failed. Offline detection disabled."

# Create COCO labels file
cat > models/coco_labels.txt << 'EOF'
person
bicycle
car
motorcycle
airplane
bus
train
truck
boat
traffic light
fire hydrant
stop sign
parking meter
bench
bird
cat
dog
horse
sheep
cow
elephant
bear
zebra
giraffe
backpack
umbrella
handbag
tie
suitcase
frisbee
skis
snowboard
sports ball
kite
baseball bat
baseball glove
skateboard
surfboard
tennis racket
bottle
wine glass
cup
fork
knife
spoon
bowl
banana
apple
sandwich
orange
broccoli
carrot
hot dog
pizza
donut
cake
chair
couch
potted plant
bed
dining table
toilet
tv
laptop
mouse
remote
keyboard
cell phone
microwave
oven
toaster
sink
refrigerator
book
clock
vase
scissors
teddy bear
hair drier
toothbrush
EOF

# Install systemd service for auto-start
echo "[8/8] Installing auto-start service..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sudo tee /etc/systemd/system/visionbridge.service > /dev/null << SVCEOF
[Unit]
Description=VisionBridge AI Assistant
After=network.target sound.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/python3 $SCRIPT_DIR/visionbridge.py
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
SVCEOF

sudo systemctl daemon-reload
sudo systemctl enable visionbridge.service

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   ✅ Setup complete!                 ║"
echo "║                                      ║"
echo "║   Next steps:                        ║"
echo "║   1. Edit config.py with your keys   ║"
echo "║   2. Test: python3 visionbridge.py   ║"
echo "║   3. Reboot to test auto-start       ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "To start manually:  python3 visionbridge.py"
echo "To start on boot:   sudo systemctl start visionbridge"
echo "To see logs:         journalctl -u visionbridge -f"
echo ""
echo "⚠️  A reboot is required for camera and serial changes."
echo "    Run: sudo reboot"
