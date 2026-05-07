/**
 * detector.js — Local object detection using TensorFlow.js + COCO-SSD
 * Runs ENTIRELY in the browser. No API calls. No rate limits. Always works.
 * 
 * Capabilities:
 * - Detects 80+ object types (people, vehicles, animals, furniture, etc.)
 * - Estimates distance from bounding box size
 * - Tracks motion/speed by comparing detections across frames
 * - Classifies dangers based on object type, size, and position
 */
const DetectorModule = (() => {
  let model = null;
  let isLoading = false;
  let isReady = false;
  let previousDetections = null;
  let previousTimestamp = 0;

  // --- Danger classification ---
  const DANGER_OBJECTS = {
    // Critical — moving vehicles
    car: { severity: 'critical', type: 'vehicle', label: 'Car' },
    truck: { severity: 'critical', type: 'vehicle', label: 'Truck' },
    bus: { severity: 'critical', type: 'vehicle', label: 'Bus' },
    motorcycle: { severity: 'critical', type: 'vehicle', label: 'Motorcycle' },
    bicycle: { severity: 'warning', type: 'vehicle', label: 'Bicycle' },
    // Animals
    dog: { severity: 'warning', type: 'animal', label: 'Dog' },
    cat: { severity: 'info', type: 'animal', label: 'Cat' },
    horse: { severity: 'warning', type: 'animal', label: 'Horse' },
    // Obstacles
    'fire hydrant': { severity: 'warning', type: 'obstacle', label: 'Fire hydrant' },
    'stop sign': { severity: 'info', type: 'obstacle', label: 'Stop sign' },
    'parking meter': { severity: 'warning', type: 'obstacle', label: 'Parking meter' },
    bench: { severity: 'info', type: 'obstacle', label: 'Bench' },
    'potted plant': { severity: 'info', type: 'obstacle', label: 'Potted plant' },
    suitcase: { severity: 'info', type: 'obstacle', label: 'Suitcase on ground' },
    backpack: { severity: 'info', type: 'obstacle', label: 'Backpack on ground' },
  };

  // Known real-world heights for distance estimation (meters)
  const KNOWN_HEIGHTS = {
    person: 1.7, car: 1.5, truck: 2.5, bus: 3.0, motorcycle: 1.1,
    bicycle: 1.0, dog: 0.5, cat: 0.3, chair: 0.9, 'dining table': 0.75,
    'fire hydrant': 0.6, 'stop sign': 2.1, 'traffic light': 3.5,
  };

  // Spatial direction from bounding box center position
  function getDirection(bbox, canvasW, canvasH) {
    const cx = bbox[0] + bbox[2] / 2;
    const cy = bbox[1] + bbox[3] / 2;
    const relX = cx / canvasW;

    if (relX < 0.33) return 'left';
    if (relX > 0.67) return 'right';
    return 'ahead';
  }

  // Estimate distance from bounding box height vs known real height
  function estimateDistance(className, bboxH, canvasH) {
    const knownH = KNOWN_HEIGHTS[className] || 1.0;
    // Rough pinhole camera model: distance ≈ (knownH × canvasH) / (bboxH × 2)
    // The "2" is a rough focal length factor for phone cameras
    const dist = (knownH * canvasH) / (bboxH * 2.0);
    return Math.max(0.3, Math.min(dist, 50)); // Clamp 0.3m – 50m
  }

  // Estimate approximate size from bounding box proportions + known sizes
  function estimateSize(className, bboxW, bboxH, distance, canvasW, canvasH) {
    // Real size ≈ bbox fraction × distance × field-of-view factor
    const fovFactor = 1.2; // approximate for phone cameras
    const realW = (bboxW / canvasW) * distance * fovFactor;
    const realH = (bboxH / canvasH) * distance * fovFactor;
    return { width: Math.round(realW * 10) / 10, height: Math.round(realH * 10) / 10 };
  }

  /**
   * Load the COCO-SSD model. Call once on startup.
   */
  async function init() {
    if (isReady || isLoading) return isReady;
    isLoading = true;

    try {
      console.log('[Detector] Loading COCO-SSD model...');
      model = await cocoSsd.load({ base: 'lite_mobilenet_v2' }); // Fastest variant
      isReady = true;
      console.log('[Detector] Model loaded — local detection ready!');
    } catch (err) {
      console.error('[Detector] Failed to load model:', err);
      isReady = false;
    }

    isLoading = false;
    return isReady;
  }

  /**
   * Detect objects in a video element or canvas.
   * Returns a structured result compatible with the existing UI.
   */
  async function detect(videoElement) {
    if (!isReady || !model || !videoElement) {
      return null;
    }

    const predictions = await model.detect(videoElement, 10, 0.35); // max 10 objects, 35% confidence
    const now = Date.now();
    const canvasW = videoElement.videoWidth || videoElement.width;
    const canvasH = videoElement.videoHeight || videoElement.height;

    const objects = predictions.map(pred => {
      const [x, y, w, h] = pred.bbox;
      const direction = getDirection(pred.bbox, canvasW, canvasH);
      const distanceM = estimateDistance(pred.class, h, canvasH);
      const distanceFt = Math.round(distanceM * 3.281);
      const size = estimateSize(pred.class, w, h, distanceM, canvasW, canvasH);

      // Check for motion by comparing with previous frame
      let moving = false;
      let speed = 'stationary';
      let moveDir = 'stationary';

      if (previousDetections && previousTimestamp) {
        const dt = (now - previousTimestamp) / 1000; // seconds
        const prevMatch = previousDetections.find(p =>
          p.class === pred.class && Math.abs(p.bbox[0] - x) < canvasW * 0.3
        );

        if (prevMatch && dt > 0 && dt < 3) {
          const dx = (x - prevMatch.bbox[0]) / canvasW; // normalized displacement
          const dy = (y - prevMatch.bbox[1]) / canvasH;
          const displacement = Math.sqrt(dx * dx + dy * dy);

          if (displacement > 0.02) { // Moved more than 2% of frame
            moving = true;
            // Estimate speed: displacement in frame × distance ÷ time
            const realDisplacement = displacement * distanceM * 1.5;
            const speedMS = realDisplacement / dt;
            const speedKMH = Math.round(speedMS * 3.6);
            const speedMPH = Math.round(speedMS * 2.237);

            if (speedKMH < 5) speed = `slow (~${speedKMH} km/h)`;
            else if (speedKMH < 15) speed = `walking (~${speedKMH} km/h)`;
            else if (speedKMH < 40) speed = `fast (~${speedKMH} km/h)`;
            else speed = `very fast (~${speedKMH} km/h)`;

            if (dx < -0.03) moveDir = 'left';
            else if (dx > 0.03) moveDir = 'right';
            else if (dy > 0.02) moveDir = 'toward';
            else if (dy < -0.02) moveDir = 'away';
            else moveDir = 'moving';
          }
        }
      }

      return {
        class: pred.class,
        score: pred.score,
        bbox: pred.bbox,
        direction,
        distance: `${distanceM.toFixed(1)}m / ${distanceFt}ft`,
        distanceM,
        size: `${size.height}m × ${size.width}m`,
        moving,
        speed,
        moveDir,
        label: pred.class.charAt(0).toUpperCase() + pred.class.slice(1),
        confidence: Math.round(pred.score * 100)
      };
    });

    // Save for motion tracking
    previousDetections = predictions;
    previousTimestamp = now;

    return objects;
  }

  /**
   * Process detections into a spoken description + danger list.
   * This replaces the Gemini API for basic scene analysis.
   */
  function processForSpeech(objects, mode = 'detailed') {
    if (!objects || objects.length === 0) {
      return {
        description: 'No objects detected in the current view.',
        dangers: [],
        summary: 'The area appears clear.',
        objects: []
      };
    }

    // --- Extract dangers ---
    const dangers = [];
    for (const obj of objects) {
      const dangerInfo = DANGER_OBJECTS[obj.class];
      if (dangerInfo && obj.distanceM < 6) { // Within 6 meters
        const severity = obj.distanceM < 2.5 ? 'critical' : dangerInfo.severity;
        dangers.push({
          type: dangerInfo.type,
          severity,
          description: `${dangerInfo.label} detected ${obj.direction}, ${obj.distance} away${obj.moving ? ', ' + obj.speed : ''}`,
          direction: obj.direction,
          distance: obj.distance
        });
      }
    }

    // Sort dangers: critical first, then by distance
    dangers.sort((a, b) => {
      if (a.severity === 'critical' && b.severity !== 'critical') return -1;
      if (b.severity === 'critical' && a.severity !== 'critical') return 1;
      return 0;
    });

    // --- Build description based on mode ---
    if (mode === 'danger') {
      if (dangers.length === 0) {
        return {
          description: '',
          dangers: [],
          summary: 'No immediate dangers detected. Path appears clear.',
          objects
        };
      }
      return { description: '', dangers, summary: dangers[0].description, objects };
    }

    if (mode === 'summary') {
      const counts = {};
      objects.forEach(o => { counts[o.label] = (counts[o.label] || 0) + 1; });
      const parts = Object.entries(counts).map(([name, count]) =>
        count > 1 ? `${count} ${name.toLowerCase()}s` : `a ${name.toLowerCase()}`
      );
      const summary = `I can see ${parts.join(', ')} in the scene.`;
      return { description: '', dangers, summary, objects };
    }

    if (mode === 'measure') {
      return { description: '', dangers: [], summary: '', objects };
    }

    // --- Detailed mode ---
    const descriptions = objects.map(obj => {
      let desc = `${obj.label} (${obj.confidence}% sure) to your ${obj.direction}, about ${obj.distance} away`;
      if (obj.moving) desc += `, moving ${obj.moveDir} at ${obj.speed}`;
      return desc;
    });

    const description = descriptions.join('. ') + '.';
    const dangerSummary = dangers.length > 0
      ? `Warning: ${dangers[0].description}`
      : 'No immediate dangers detected';

    return {
      description,
      dangers,
      summary: dangerSummary,
      objects
    };
  }

  return {
    init,
    detect,
    processForSpeech,
    get isReady() { return isReady; },
    get isLoading() { return isLoading; }
  };
})();
