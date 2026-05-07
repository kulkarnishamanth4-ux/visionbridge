/**
 * detector.js — Local object detection using TensorFlow.js + COCO-SSD
 * Runs ENTIRELY in the browser. No API calls. No rate limits. Always works.
 */
const DetectorModule = (() => {
  let model = null;
  let isLoading = false;
  let isReady = false;
  let previousDetections = null;
  let previousTimestamp = 0;

  const DANGER_OBJECTS = {
    car: { severity: 'critical', type: 'vehicle', label: 'Car' },
    truck: { severity: 'critical', type: 'vehicle', label: 'Truck' },
    bus: { severity: 'critical', type: 'vehicle', label: 'Bus' },
    motorcycle: { severity: 'critical', type: 'vehicle', label: 'Motorcycle' },
    bicycle: { severity: 'warning', type: 'vehicle', label: 'Bicycle' },
    dog: { severity: 'warning', type: 'animal', label: 'Dog' },
    cat: { severity: 'info', type: 'animal', label: 'Cat' },
    horse: { severity: 'warning', type: 'animal', label: 'Horse' },
    'fire hydrant': { severity: 'warning', type: 'obstacle', label: 'Fire hydrant' },
    'stop sign': { severity: 'info', type: 'obstacle', label: 'Stop sign' },
    'parking meter': { severity: 'warning', type: 'obstacle', label: 'Parking meter' },
    bench: { severity: 'info', type: 'obstacle', label: 'Bench' },
    'potted plant': { severity: 'info', type: 'obstacle', label: 'Potted plant' },
    suitcase: { severity: 'info', type: 'obstacle', label: 'Suitcase on ground' },
    backpack: { severity: 'info', type: 'obstacle', label: 'Backpack on ground' },
  };

  // Direction from bounding box center
  function getDirection(bbox, canvasW) {
    const cx = bbox[0] + bbox[2] / 2;
    const relX = cx / canvasW;
    if (relX < 0.33) return 'left';
    if (relX > 0.67) return 'right';
    return 'ahead';
  }

  /**
   * DISTANCE ESTIMATION — Frame-fill percentage approach.
   * Much more accurate than pinhole model, especially at close range.
   * If you fill 70%+ of the frame, you're within arm's reach.
   */
  function estimateDistance(bboxH, canvasH) {
    const fill = bboxH / canvasH;
    if (fill > 0.85) return 0.3;
    if (fill > 0.70) return 0.5;
    if (fill > 0.55) return 0.8;
    if (fill > 0.40) return 1.2;
    if (fill > 0.30) return 2.0;
    if (fill > 0.20) return 3.0;
    if (fill > 0.12) return 5.0;
    if (fill > 0.07) return 8.0;
    if (fill > 0.04) return 12.0;
    return 20.0;
  }

  function distanceLabel(m) {
    if (m <= 0.5) return "within arm's reach";
    if (m <= 1.0) return 'very close, about 1 step';
    if (m <= 2.0) return 'close, 1 to 2 steps';
    if (m <= 3.5) return 'nearby, a few steps';
    if (m <= 6.0) return 'several steps away';
    if (m <= 10.0) return 'across the room';
    return 'far away';
  }

  function estimateSize(bboxW, bboxH, distance, canvasW, canvasH) {
    const realW = (bboxW / canvasW) * distance;
    const realH = (bboxH / canvasH) * distance;
    return { width: Math.round(realW * 10) / 10, height: Math.round(realH * 10) / 10 };
  }

  async function init() {
    if (isReady || isLoading) return isReady;
    isLoading = true;
    try {
      console.log('[Detector] Loading COCO-SSD...');
      model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      isReady = true;
      console.log('[Detector] Model loaded!');
    } catch (err) {
      console.error('[Detector] Load failed:', err);
      isReady = false;
    }
    isLoading = false;
    return isReady;
  }

  async function detect(videoElement) {
    if (!isReady || !model || !videoElement) return null;

    const predictions = await model.detect(videoElement, 10, 0.35);
    const now = Date.now();
    const canvasW = videoElement.videoWidth || videoElement.width;
    const canvasH = videoElement.videoHeight || videoElement.height;

    const objects = predictions.map(pred => {
      const [x, y, w, h] = pred.bbox;
      const direction = getDirection(pred.bbox, canvasW);
      const distanceM = estimateDistance(h, canvasH);
      const distanceFt = Math.round(distanceM * 3.281);
      const dLabel = distanceLabel(distanceM);
      const size = estimateSize(w, h, distanceM, canvasW, canvasH);

      // Motion tracking
      let moving = false, speed = 'stationary', moveDir = 'stationary';
      if (previousDetections && previousTimestamp) {
        const dt = (now - previousTimestamp) / 1000;
        const prevMatch = previousDetections.find(p =>
          p.class === pred.class && Math.abs(p.bbox[0] - x) < canvasW * 0.3
        );
        if (prevMatch && dt > 0 && dt < 3) {
          const dx = (x - prevMatch.bbox[0]) / canvasW;
          const dy = (y - prevMatch.bbox[1]) / canvasH;
          const disp = Math.sqrt(dx * dx + dy * dy);
          if (disp > 0.02) {
            moving = true;
            const realDisp = disp * distanceM * 1.5;
            const sMs = realDisp / dt;
            const sKmh = Math.round(sMs * 3.6);
            if (sKmh < 5) speed = `slow (~${sKmh} km/h)`;
            else if (sKmh < 15) speed = `walking (~${sKmh} km/h)`;
            else if (sKmh < 40) speed = `fast (~${sKmh} km/h)`;
            else speed = `very fast (~${sKmh} km/h)`;
            if (dx < -0.03) moveDir = 'left';
            else if (dx > 0.03) moveDir = 'right';
            else if (dy > 0.02) moveDir = 'toward';
            else if (dy < -0.02) moveDir = 'away';
            else moveDir = 'moving';
          }
        }
      }

      return {
        class: pred.class, score: pred.score, bbox: pred.bbox,
        direction,
        distance: `${dLabel} (~${distanceM.toFixed(1)}m / ${distanceFt}ft)`,
        distanceM,
        size: `~${size.height}m x ${size.width}m`,
        moving, speed, moveDir,
        label: pred.class.charAt(0).toUpperCase() + pred.class.slice(1),
        confidence: Math.round(pred.score * 100)
      };
    });

    previousDetections = predictions;
    previousTimestamp = now;
    return objects;
  }

  function processForSpeech(objects, mode = 'detailed') {
    if (!objects || objects.length === 0) {
      return { description: 'No objects detected in the current view.', dangers: [], summary: 'The area appears clear.', objects: [] };
    }

    const dangers = [];
    for (const obj of objects) {
      const d = DANGER_OBJECTS[obj.class];
      if (d && obj.distanceM < 6) {
        const sev = obj.distanceM < 2.5 ? 'critical' : d.severity;
        dangers.push({
          type: d.type, severity: sev,
          description: `${d.label} ${obj.direction}, ${obj.distance}${obj.moving ? ', ' + obj.speed : ''}`,
          direction: obj.direction, distance: obj.distance, distanceM: obj.distanceM
        });
      }
    }
    dangers.sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1));

    if (mode === 'danger') {
      if (!dangers.length) return { description: '', dangers: [], summary: 'No immediate dangers. Path appears clear.', objects };
      return { description: '', dangers, summary: dangers[0].description, objects };
    }
    if (mode === 'summary') {
      const counts = {};
      objects.forEach(o => { counts[o.label] = (counts[o.label] || 0) + 1; });
      const parts = Object.entries(counts).map(([n, c]) => c > 1 ? `${c} ${n.toLowerCase()}s` : `a ${n.toLowerCase()}`);
      return { description: '', dangers, summary: `I can see ${parts.join(', ')} in the scene.`, objects };
    }
    if (mode === 'measure') return { description: '', dangers: [], summary: '', objects };

    // Detailed
    const descs = objects.map(o => {
      let d = `${o.label} (${o.confidence}%) to your ${o.direction}, ${o.distance}`;
      if (o.moving) d += `, moving ${o.moveDir} at ${o.speed}`;
      return d;
    });
    return {
      description: descs.join('. ') + '.',
      dangers, summary: dangers.length ? `Warning: ${dangers[0].description}` : 'No immediate dangers',
      objects
    };
  }

  return {
    init, detect, processForSpeech,
    get isReady() { return isReady; },
    get isLoading() { return isLoading; }
  };
})();
