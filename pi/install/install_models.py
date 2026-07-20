"""
install_models.py — Download TFLite object detection model.
Downloads the COCO-SSD MobileNet model with size verification
and creates the labels file.
"""
import os
import subprocess
import logging

log = logging.getLogger("install.models")

MODEL_URL = "https://storage.googleapis.com/download.tensorflow.org/models/tflite/coco_ssd_mobilenet_v1_1.0_quant_2018_06_29.zip"
MODEL_FILENAME = "coco_ssd_mobilenet_v2.tflite"
LABELS_FILENAME = "coco_labels.txt"
MIN_MODEL_SIZE_BYTES = 3_000_000  # model should be ~4MB

COCO_LABELS = """person
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
toothbrush""".strip()


def install(project_dir):
    """
    Download TFLite model and create labels file.
    Returns True on success.
    """
    models_dir = os.path.join(project_dir, "models")
    model_path = os.path.join(models_dir, MODEL_FILENAME)
    labels_path = os.path.join(models_dir, LABELS_FILENAME)

    os.makedirs(models_dir, exist_ok=True)

    # --- Create labels file ---
    log.info(f"Creating labels file: {labels_path}")
    try:
        with open(labels_path, "w") as f:
            f.write(COCO_LABELS + "\n")
        label_count = len(COCO_LABELS.strip().splitlines())
        log.info(f"  Labels file created ({label_count} classes)")
    except Exception as e:
        log.error(f"  Failed to create labels file: {e}")
        return False

    # --- Download model ---
    if os.path.exists(model_path):
        size = os.path.getsize(model_path)
        if size >= MIN_MODEL_SIZE_BYTES:
            log.info(f"Model already exists: {model_path} ({size:,} bytes) — skipping download")
            return True
        else:
            log.warning(f"Existing model is too small ({size} bytes) — re-downloading")

    log.info("Downloading COCO-SSD MobileNet v1 model...")
    tmp_zip = "/tmp/coco_ssd_vb.zip"
    tmp_dir = "/tmp/coco_ssd_vb_extract"

    # Download
    ok = _download(MODEL_URL, tmp_zip)
    if not ok:
        log.error("Model download failed! Check internet connection.")
        log.info("  You can download manually later:")
        log.info(f"  URL: {MODEL_URL}")
        log.info(f"  Extract .tflite to: {model_path}")
        return False

    # Verify download size
    if os.path.exists(tmp_zip):
        zip_size = os.path.getsize(tmp_zip)
        log.info(f"  Downloaded: {zip_size:,} bytes")
    else:
        log.error("  Download file not found")
        return False

    # Extract
    ok = _extract(tmp_zip, tmp_dir, model_path)
    if not ok:
        log.error("Model extraction failed!")
        return False

    # Verify model file
    if os.path.exists(model_path):
        model_size = os.path.getsize(model_path)
        if model_size >= MIN_MODEL_SIZE_BYTES:
            log.info(f"  Model verified: {model_path} ({model_size:,} bytes)")
        else:
            log.warning(f"  Model file seems too small: {model_size} bytes")
    else:
        log.error(f"  Model file not found after extraction: {model_path}")
        return False

    # Cleanup
    _cleanup(tmp_zip, tmp_dir)

    return True


def _download(url, dest):
    """Download a file using wget."""
    try:
        result = subprocess.run(
            ["wget", "-q", "--show-progress", "-O", dest, url],
            timeout=120,
        )
        return result.returncode == 0
    except FileNotFoundError:
        # wget not available, try curl
        try:
            result = subprocess.run(
                ["curl", "-L", "-o", dest, url],
                timeout=120,
            )
            return result.returncode == 0
        except Exception:
            return False
    except Exception:
        return False


def _extract(zip_path, extract_dir, model_dest):
    """Extract the .tflite file from the zip."""
    try:
        os.makedirs(extract_dir, exist_ok=True)
        result = subprocess.run(
            ["unzip", "-o", zip_path, "-d", extract_dir],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if result.returncode != 0:
            return False

        # Find the .tflite file
        for root, dirs, files in os.walk(extract_dir):
            for f in files:
                if f.endswith(".tflite"):
                    src = os.path.join(root, f)
                    # Copy to destination
                    import shutil
                    shutil.copy2(src, model_dest)
                    return True

        log.error("No .tflite file found in archive")
        return False
    except Exception as e:
        log.error(f"Extraction error: {e}")
        return False


def _cleanup(zip_path, extract_dir):
    """Remove temporary files."""
    try:
        if os.path.exists(zip_path):
            os.remove(zip_path)
        import shutil
        if os.path.exists(extract_dir):
            shutil.rmtree(extract_dir)
    except Exception:
        pass
