/**
 * detector.js — Local object detection using TensorFlow.js + COCO-SSD
 * Runs ENTIRELY in the browser. No API calls. No rate limits. Always works.
 *
 * v2: Upgraded model, class-aware distance, FOV-based size, smoothed motion tracking.
 */
const DetectorModule = (() => {
  let model = null;
  let isLoading = false;
  let isReady = false;

  // Motion history: stores last N frames of detections for smoothing
  const HISTORY_SIZE = 5;
  let detectionHistory = [];  // Array of { timestamp, detections[] }

  // =============================================
  //   KNOWN REAL-WORLD OBJECT DIMENSIONS (meters)
  //   Used for class-aware distance calibration
  // =============================================
  const KNOWN_HEIGHTS = {
    person: 1.65, man: 1.70, woman: 1.60, child: 1.10,
    car: 1.50, truck: 2.80, bus: 3.00,
    motorcycle: 1.10, bicycle: 1.00,
    dog: 0.45, cat: 0.30, horse: 1.60, cow: 1.40, sheep: 0.75,
    bird: 0.15, elephant: 3.00, bear: 1.50, zebra: 1.40, giraffe: 5.50,
    'fire hydrant': 0.60, 'stop sign': 0.75, 'parking meter': 1.20,
    bench: 0.80, chair: 0.90, 'dining table': 0.75,
    'potted plant': 0.50, suitcase: 0.60, backpack: 0.50,
    umbrella: 1.00, handbag: 0.35, bottle: 0.25,
    tv: 0.50, laptop: 0.25, 'cell phone': 0.14,
    refrigerator: 1.70, oven: 0.85, microwave: 0.30,
    toilet: 0.40, sink: 0.35, bed: 0.60, couch: 0.85,
  };

  const KNOWN_WIDTHS = {
    person: 0.45, car: 1.80, truck: 2.50, bus: 2.50,
    motorcycle: 0.80, bicycle: 0.60,
    dog: 0.60, cat: 0.40, cow: 2.00, horse: 2.20,
    bench: 1.50, chair: 0.50, 'dining table': 1.20,
    suitcase: 0.40, tv: 0.90, laptop: 0.35,
    refrigerator: 0.70, bed: 1.50, couch: 1.80,
  };

  // Approximate camera horizontal FOV in radians (~60° for most phone cameras)
  const CAMERA_HFOV = 60 * (Math.PI / 180);
  const CAMERA_VFOV = 45 * (Math.PI / 180);

  // Danger classification
  const DANGER_OBJECTS = {
    car: { severity: 'critical', type: 'vehicle', label: 'Car' },
    truck: { severity: 'critical', type: 'vehicle', label: 'Truck' },
    bus: { severity: 'critical', type: 'vehicle', label: 'Bus' },
    motorcycle: { severity: 'critical', type: 'vehicle', label: 'Motorcycle' },
    bicycle: { severity: 'warning', type: 'vehicle', label: 'Bicycle' },
    dog: { severity: 'warning', type: 'animal', label: 'Dog' },
    cat: { severity: 'info', type: 'animal', label: 'Cat' },
    horse: { severity: 'warning', type: 'animal', label: 'Horse' },
    cow: { severity: 'warning', type: 'animal', label: 'Cow' },
    'fire hydrant': { severity: 'warning', type: 'obstacle', label: 'Fire hydrant' },
    'stop sign': { severity: 'info', type: 'obstacle', label: 'Stop sign' },
    'parking meter': { severity: 'warning', type: 'obstacle', label: 'Parking meter' },
    bench: { severity: 'info', type: 'obstacle', label: 'Bench' },
    'potted plant': { severity: 'info', type: 'obstacle', label: 'Potted plant' },
    suitcase: { severity: 'info', type: 'obstacle', label: 'Suitcase on ground' },
    backpack: { severity: 'info', type: 'obstacle', label: 'Backpack on ground' },
  };

  // =============================================
  //   DIRECTION ESTIMATION (3-zone + clock)
  // =============================================
  function getDirection(bbox, canvasW) {
    const cx = bbox[0] + bbox[2] / 2;
    const relX = cx / canvasW;
    if (relX < 0.25) return 'left';
    if (relX < 0.42) return 'slightly left';
    if (relX > 0.75) return 'right';
    if (relX > 0.58) return 'slightly right';
    return 'ahead';
  }

  function getClockDirection(bbox, canvasW) {
    const cx = bbox[0] + bbox[2] / 2;
    const relX = cx / canvasW;
    if (relX < 0.15) return '9 o\'clock';
    if (relX < 0.30) return '10 o\'clock';
    if (relX < 0.42) return '11 o\'clock';
    if (relX < 0.58) return '12 o\'clock';
    if (relX < 0.70) return '1 o\'clock';
    if (relX < 0.85) return '2 o\'clock';
    return '3 o\'clock';
  }

  // =============================================
  //   DISTANCE ESTIMATION — Class-aware pinhole model
  // =============================================
  //   DISTANCE ESTIMATION — Hybrid: pinhole + fill-based
  //   Pinhole model is accurate in the mid-range (1-10m) but
  //   breaks down at extremes:
  //   - Too close: bbox overflows frame, bboxH ≈ canvasH
  //   - Too far: bbox is tiny, noise dominates
  //   Solution: blend with fill-based model at extremes.
  // =============================================
  function estimateDistance(objClass, bboxW, bboxH, canvasW, canvasH) {
    // Guard against degenerate inputs
    if (bboxH < 3 || canvasH < 10) return 5.0;

    const fill = bboxH / canvasH;
    const knownH = KNOWN_HEIGHTS[objClass];

    // Fill-based distance (always computed, used as anchor/blend)
    let fillDist;
    if (fill >= 0.90) fillDist = 0.2;
    else if (fill >= 0.75) fillDist = 0.4;
    else if (fill >= 0.60) fillDist = 0.7;
    else if (fill >= 0.45) fillDist = 1.0;
    else if (fill >= 0.30) fillDist = 1.8;
    else if (fill >= 0.20) fillDist = 3.0;
    else if (fill >= 0.12) fillDist = 5.0;
    else if (fill >= 0.07) fillDist = 8.0;
    else if (fill >= 0.04) fillDist = 12.0;
    else if (fill >= 0.02) fillDist = 18.0;
    else fillDist = 25.0;

    if (!knownH) {
      // No known height — use fill-based only
      return Math.max(0.2, Math.min(fillDist, 25.0));
    }

    // Pinhole model: d = (H_real * f) / h_pixels
    const focalPx = (canvasH / 2) / Math.tan(CAMERA_VFOV / 2);
    let pinholeDist = (knownH * focalPx) / bboxH;

    // Blend strategy:
    //   fill > 0.7 (very close): trust fill-based more (pinhole overestimates closeness)
    //   fill < 0.05 (very far): trust fill-based more (pinhole noise explodes)
    //   0.05 < fill < 0.7 (mid-range): trust pinhole more (most accurate here)
    let blendWeight; // 0 = pure fill, 1 = pure pinhole
    if (fill > 0.70) {
      // Very close: fade from pinhole to fill
      blendWeight = Math.max(0, (0.85 - fill) / 0.15); // 0.85→1.0, 0.70→0.0
    } else if (fill < 0.05) {
      // Very far: fade from pinhole to fill
      blendWeight = Math.max(0, fill / 0.05); // 0.05→1.0, 0→0.0
    } else {
      // Mid-range: trust pinhole fully
      blendWeight = 1.0;
    }

    const blended = blendWeight * pinholeDist + (1 - blendWeight) * fillDist;

    // Final clamp
    return Math.max(0.2, Math.min(Math.round(blended * 10) / 10, 25.0));
  }

  function distanceLabel(m) {
    if (m <= 0.5) return "within arm's reach";
    if (m <= 1.0) return 'very close, about 1 step';
    if (m <= 1.5) return 'close, about 2 steps';
    if (m <= 2.5) return 'nearby, a few steps';
    if (m <= 4.0) return 'a short walk';
    if (m <= 7.0) return 'several steps away';
    if (m <= 12.0) return 'across the room';
    return 'far away';
  }

  // =============================================
  //   SIZE ESTIMATION — FOV-based real-world size
  //   Uses camera FOV to project pixel dimensions back to real-world meters
  // =============================================
  function estimateSize(objClass, bboxW, bboxH, distanceM, canvasW, canvasH) {
    // Calculate real-world dimensions from FOV projection
    const worldViewW = 2 * distanceM * Math.tan(CAMERA_HFOV / 2);
    const worldViewH = 2 * distanceM * Math.tan(CAMERA_VFOV / 2);

    let realW = (bboxW / canvasW) * worldViewW;
    let realH = (bboxH / canvasH) * worldViewH;

    // Cross-check with known dimensions and clamp to reasonable range
    const knownH = KNOWN_HEIGHTS[objClass];
    const knownW = KNOWN_WIDTHS[objClass];

    if (knownH) {
      // If estimated height is wildly off from known height, use known height
      // and scale width proportionally
      if (realH > knownH * 2.5 || realH < knownH * 0.3) {
        const scale = knownH / realH;
        realH = knownH;
        realW = realW * scale;
      }
    }
    if (knownW && realW > knownW * 3) {
      realW = knownW;
    }

    return {
      width: Math.round(realW * 10) / 10,
      height: Math.round(realH * 10) / 10
    };
  }

  function sizeLabel(sizeObj) {
    const h = sizeObj.height;
    const w = sizeObj.width;
    const area = h * w;

    if (area < 0.05) return 'tiny';
    if (area < 0.15) return 'small';
    if (area < 0.5) return 'medium';
    if (area < 2.0) return 'large';
    return 'very large';
  }

  // =============================================
  //   MODEL INITIALIZATION
  // =============================================
  async function init() {
    if (isReady || isLoading) return isReady;
    isLoading = true;
    try {
      console.log('[Detector] Loading COCO-SSD (mobilenet_v2)...');
      // Use full mobilenet_v2 for better accuracy (vs lite_mobilenet_v2)
      model = await cocoSsd.load({ base: 'mobilenet_v2' });
      isReady = true;
      console.log('[Detector] Model loaded — full mobilenet_v2');
    } catch (err) {
      console.warn('[Detector] mobilenet_v2 failed, trying lite...', err.message);
      try {
        model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        isReady = true;
        console.log('[Detector] Model loaded — lite_mobilenet_v2 (fallback)');
      } catch (err2) {
        console.error('[Detector] All models failed:', err2);
        isReady = false;
      }
    }
    isLoading = false;
    return isReady;
  }

  // =============================================
  //   MOTION TRACKING — Smoothed, jitter-resistant
  // =============================================

  /**
   * Find the best match for a detection in a previous frame.
   * Uses class match + spatial proximity + size similarity.
   */
  function findPreviousMatch(pred, prevDetections, canvasW, canvasH) {
    let bestMatch = null;
    let bestScore = Infinity;

    for (const prev of prevDetections) {
      if (prev.class !== pred.class) continue;

      const cx1 = pred.bbox[0] + pred.bbox[2] / 2;
      const cy1 = pred.bbox[1] + pred.bbox[3] / 2;
      const cx2 = prev.bbox[0] + prev.bbox[2] / 2;
      const cy2 = prev.bbox[1] + prev.bbox[3] / 2;

      // Normalized distance (0-1 range)
      const dx = (cx1 - cx2) / canvasW;
      const dy = (cy1 - cy2) / canvasH;
      const spatialDist = Math.sqrt(dx * dx + dy * dy);

      // Size similarity (ratio of areas)
      const area1 = pred.bbox[2] * pred.bbox[3];
      const area2 = prev.bbox[2] * prev.bbox[3];
      const sizeRatio = Math.max(area1, area2) / Math.min(area1, area2);

      // Combined score (lower is better)
      const score = spatialDist + (sizeRatio - 1) * 0.2;

      // Must be within 40% of frame and size ratio < 3x
      if (spatialDist < 0.4 && sizeRatio < 3 && score < bestScore) {
        bestScore = score;
        bestMatch = prev;
      }
    }
    return bestMatch;
  }

  /**
   * Calculate motion from detection history (multi-frame smoothing).
   * Averages velocity across the last N frames to eliminate jitter.
   */
  function calculateMotion(pred, canvasW, canvasH, distanceM) {
    if (detectionHistory.length < 2) {
      return { moving: false, speed: 'stationary', moveDir: 'stationary', speedKmh: 0 };
    }

    const velocities = [];

    // Look at all consecutive frame pairs in history
    for (let i = 1; i < detectionHistory.length; i++) {
      const prevFrame = detectionHistory[i - 1];
      const currFrame = detectionHistory[i];
      const dt = (currFrame.timestamp - prevFrame.timestamp) / 1000;
      if (dt <= 0 || dt > 3) continue; // skip bad intervals

      const match = findPreviousMatch(pred, prevFrame.detections, canvasW, canvasH);
      if (!match) continue;

      const dx = ((pred.bbox[0] + pred.bbox[2] / 2) - (match.bbox[0] + match.bbox[2] / 2)) / canvasW;
      const dy = ((pred.bbox[1] + pred.bbox[3] / 2) - (match.bbox[1] + match.bbox[3] / 2)) / canvasH;

      // Convert pixel displacement to real-world displacement using FOV
      const worldViewW = 2 * distanceM * Math.tan(CAMERA_HFOV / 2);
      const worldViewH = 2 * distanceM * Math.tan(CAMERA_VFOV / 2);
      const realDx = dx * worldViewW;
      const realDy = dy * worldViewH;
      const realDisp = Math.sqrt(realDx * realDx + realDy * realDy);

      velocities.push({ vMs: realDisp / dt, dx, dy });
    }

    if (velocities.length === 0) {
      return { moving: false, speed: 'stationary', moveDir: 'stationary', speedKmh: 0 };
    }

    // Average velocity (smoothing)
    const avgVMs = velocities.reduce((s, v) => s + v.vMs, 0) / velocities.length;
    const avgDx = velocities.reduce((s, v) => s + v.dx, 0) / velocities.length;
    const avgDy = velocities.reduce((s, v) => s + v.dy, 0) / velocities.length;
    const speedKmh = Math.round(avgVMs * 3.6);

    // Motion threshold: require > 0.5 km/h to count as moving
    // This eliminates jitter from detection bbox wobble
    if (speedKmh < 1) {
      return { moving: false, speed: 'stationary', moveDir: 'stationary', speedKmh: 0 };
    }

    let speed, moveDir;
    if (speedKmh < 4) speed = `slow (~${speedKmh} km/h)`;
    else if (speedKmh < 8) speed = `walking pace (~${speedKmh} km/h)`;
    else if (speedKmh < 20) speed = `fast (~${speedKmh} km/h)`;
    else if (speedKmh < 50) speed = `vehicle speed (~${speedKmh} km/h)`;
    else speed = `very fast (~${speedKmh} km/h)`;

    // Direction from averaged displacement
    if (Math.abs(avgDx) > Math.abs(avgDy) * 1.5) {
      moveDir = avgDx < 0 ? 'left' : 'right';
    } else if (Math.abs(avgDy) > Math.abs(avgDx) * 1.5) {
      moveDir = avgDy > 0 ? 'toward you' : 'away';
    } else {
      moveDir = avgDy > 0
        ? (avgDx < 0 ? 'toward you from the left' : 'toward you from the right')
        : 'moving';
    }

    return { moving: true, speed, moveDir, speedKmh };
  }

  // =============================================
  //   MAIN DETECT FUNCTION
  // =============================================
  async function detect(videoElement) {
    if (!isReady || !model || !videoElement) return null;

    // More detections (20) and lower threshold (0.25) for better coverage
    const predictions = await model.detect(videoElement, 20, 0.25);
    const now = Date.now();
    const canvasW = videoElement.videoWidth || videoElement.width;
    const canvasH = videoElement.videoHeight || videoElement.height;

    // Deduplicate overlapping detections of the same class (NMS wasn't perfect)
    const filtered = deduplicateDetections(predictions, canvasW, canvasH);

    const objects = filtered.map(pred => {
      const [x, y, w, h] = pred.bbox;
      const direction = getDirection(pred.bbox, canvasW);
      const clockDir = getClockDirection(pred.bbox, canvasW);
      const distanceM = estimateDistance(pred.class, w, h, canvasW, canvasH);
      const distanceFt = Math.round(distanceM * 3.281);
      const dLabel = distanceLabel(distanceM);
      const size = estimateSize(pred.class, w, h, distanceM, canvasW, canvasH);
      const sLabel = sizeLabel(size);

      // Smoothed motion tracking
      const motion = calculateMotion(pred, canvasW, canvasH, distanceM);

      return {
        class: pred.class, score: pred.score, bbox: pred.bbox,
        direction,
        clockDirection: clockDir,
        distance: `${dLabel} (~${distanceM.toFixed(1)}m / ${distanceFt}ft)`,
        distanceM: Math.round(distanceM * 10) / 10,
        size: `~${size.height}m tall × ${size.width}m wide`,
        sizeLabel: sLabel,
        sizeObj: size,
        moving: motion.moving,
        speed: motion.speed,
        moveDir: motion.moveDir,
        speedKmh: motion.speedKmh,
        label: pred.class.charAt(0).toUpperCase() + pred.class.slice(1),
        confidence: Math.round(pred.score * 100)
      };
    });

    // Update history ring buffer
    detectionHistory.push({ timestamp: now, detections: filtered });
    if (detectionHistory.length > HISTORY_SIZE) {
      detectionHistory.shift();
    }

    return objects;
  }

  /**
   * Remove overlapping detections of the same class (IoU > 0.5).
   * Keeps the higher-confidence one.
   */
  function deduplicateDetections(predictions, canvasW, canvasH) {
    const sorted = [...predictions].sort((a, b) => b.score - a.score);
    const keep = [];

    for (const pred of sorted) {
      let dominated = false;
      for (const kept of keep) {
        if (kept.class === pred.class && iou(kept.bbox, pred.bbox) > 0.45) {
          dominated = true;
          break;
        }
      }
      if (!dominated) keep.push(pred);
    }
    return keep;
  }

  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
    const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = a[2] * a[3];
    const areaB = b[2] * b[3];
    return inter / (areaA + areaB - inter);
  }

  // =============================================
  //   SPEECH OUTPUT GENERATOR
  // =============================================
  function processForSpeech(objects, mode = 'detailed') {
    if (!objects || objects.length === 0) {
      return { description: 'No objects detected in the current view.', dangers: [], summary: 'The area appears clear.', objects: [] };
    }

    // Sort objects by distance (nearest first)
    const sorted = [...objects].sort((a, b) => a.distanceM - b.distanceM);

    const dangers = [];
    for (const obj of sorted) {
      const d = DANGER_OBJECTS[obj.class];
      if (d && obj.distanceM < 6) {
        const sev = obj.distanceM < 2.5 ? 'critical' : d.severity;
        const motionInfo = obj.moving ? `, ${obj.speed}, moving ${obj.moveDir}` : '';
        dangers.push({
          type: d.type, severity: sev,
          description: `${d.label} at your ${obj.clockDirection}, ${obj.distance}${motionInfo}`,
          direction: obj.direction, distance: obj.distance, distanceM: obj.distanceM
        });
      }
    }
    dangers.sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      return (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2) || a.distanceM - b.distanceM;
    });

    if (mode === 'danger') {
      if (!dangers.length) return { description: '', dangers: [], summary: 'No immediate dangers. Path appears clear.', objects: sorted };
      return { description: '', dangers, summary: dangers[0].description, objects: sorted };
    }
    if (mode === 'summary') {
      const counts = {};
      sorted.forEach(o => { counts[o.label] = (counts[o.label] || 0) + 1; });
      const parts = Object.entries(counts).map(([n, c]) => c > 1 ? `${c} ${n.toLowerCase()}s` : `a ${n.toLowerCase()}`);
      const nearest = sorted[0];
      const nearestInfo = nearest ? ` Nearest: ${nearest.label} ${nearest.distance}.` : '';
      return { description: '', dangers, summary: `I can see ${parts.join(', ')}.${nearestInfo}`, objects: sorted };
    }
    if (mode === 'measure') return { description: '', dangers: [], summary: '', objects: sorted };

    // Detailed mode — rich descriptions with distance, size, and motion
    const descs = sorted.map(o => {
      let d = `${o.label} (${o.confidence}%) at your ${o.clockDirection}, ${o.distance}`;
      if (o.sizeLabel !== 'tiny') d += `, ${o.sizeLabel} (${o.size})`;
      if (o.moving) d += `, moving ${o.moveDir} at ${o.speed}`;
      return d;
    });

    const dangerSummary = dangers.length > 0
      ? `Warning: ${dangers[0].description}`
      : 'No immediate dangers';

    return {
      description: descs.join('. ') + '.',
      dangers, summary: dangerSummary,
      objects: sorted
    };
  }

  return {
    init, detect, processForSpeech,
    get isReady() { return isReady; },
    get isLoading() { return isLoading; }
  };
})();
