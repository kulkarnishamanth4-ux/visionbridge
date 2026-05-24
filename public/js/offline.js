/**
 * offline.js — Offline Scene Description Engine for VisionBridge
 * Generates natural-sounding descriptions from COCO-SSD detections
 * when the Gemini API is unreachable (no internet).
 *
 * This is the brain of the offline mode — it turns raw object detections
 * into spatial, descriptive sentences a blind person can understand.
 */
const OfflineModule = (() => {
  'use strict';

  // Friendly names and context for COCO-SSD classes
  const OBJECT_CONTEXT = {
    person: { article: 'a', plural: 'people', spatial: true },
    bicycle: { article: 'a', plural: 'bicycles', spatial: true, moving: true },
    car: { article: 'a', plural: 'cars', spatial: true, moving: true, danger: true },
    motorcycle: { article: 'a', plural: 'motorcycles', spatial: true, moving: true, danger: true },
    airplane: { article: 'an', plural: 'airplanes', spatial: false },
    bus: { article: 'a', plural: 'buses', spatial: true, moving: true, danger: true },
    train: { article: 'a', plural: 'trains', spatial: true, moving: true, danger: true },
    truck: { article: 'a', plural: 'trucks', spatial: true, moving: true, danger: true },
    boat: { article: 'a', plural: 'boats', spatial: false },
    'traffic light': { article: 'a', plural: 'traffic lights', spatial: true },
    'fire hydrant': { article: 'a', plural: 'fire hydrants', spatial: true },
    'stop sign': { article: 'a', plural: 'stop signs', spatial: true },
    'parking meter': { article: 'a', plural: 'parking meters', spatial: true },
    bench: { article: 'a', plural: 'benches', spatial: true },
    bird: { article: 'a', plural: 'birds', spatial: false },
    cat: { article: 'a', plural: 'cats', spatial: true },
    dog: { article: 'a', plural: 'dogs', spatial: true },
    horse: { article: 'a', plural: 'horses', spatial: true },
    sheep: { article: 'a', plural: 'sheep', spatial: true },
    cow: { article: 'a', plural: 'cows', spatial: true },
    elephant: { article: 'an', plural: 'elephants', spatial: true },
    bear: { article: 'a', plural: 'bears', spatial: true },
    zebra: { article: 'a', plural: 'zebras', spatial: true },
    giraffe: { article: 'a', plural: 'giraffes', spatial: true },
    backpack: { article: 'a', plural: 'backpacks', spatial: false },
    umbrella: { article: 'an', plural: 'umbrellas', spatial: false },
    handbag: { article: 'a', plural: 'handbags', spatial: false },
    tie: { article: 'a', plural: 'ties', spatial: false },
    suitcase: { article: 'a', plural: 'suitcases', spatial: true },
    frisbee: { article: 'a', plural: 'frisbees', spatial: false },
    skis: { article: 'some', plural: 'skis', spatial: false },
    snowboard: { article: 'a', plural: 'snowboards', spatial: false },
    'sports ball': { article: 'a', plural: 'sports balls', spatial: false },
    kite: { article: 'a', plural: 'kites', spatial: false },
    'baseball bat': { article: 'a', plural: 'baseball bats', spatial: false },
    'baseball glove': { article: 'a', plural: 'baseball gloves', spatial: false },
    skateboard: { article: 'a', plural: 'skateboards', spatial: true },
    surfboard: { article: 'a', plural: 'surfboards', spatial: false },
    'tennis racket': { article: 'a', plural: 'tennis rackets', spatial: false },
    bottle: { article: 'a', plural: 'bottles', spatial: false },
    'wine glass': { article: 'a', plural: 'wine glasses', spatial: false },
    cup: { article: 'a', plural: 'cups', spatial: false },
    fork: { article: 'a', plural: 'forks', spatial: false },
    knife: { article: 'a', plural: 'knives', spatial: false },
    spoon: { article: 'a', plural: 'spoons', spatial: false },
    bowl: { article: 'a', plural: 'bowls', spatial: false },
    banana: { article: 'a', plural: 'bananas', spatial: false },
    apple: { article: 'an', plural: 'apples', spatial: false },
    sandwich: { article: 'a', plural: 'sandwiches', spatial: false },
    orange: { article: 'an', plural: 'oranges', spatial: false },
    broccoli: { article: 'some', plural: 'broccoli', spatial: false },
    carrot: { article: 'a', plural: 'carrots', spatial: false },
    'hot dog': { article: 'a', plural: 'hot dogs', spatial: false },
    pizza: { article: 'a', plural: 'pizza', spatial: false },
    donut: { article: 'a', plural: 'donuts', spatial: false },
    cake: { article: 'a', plural: 'cakes', spatial: false },
    chair: { article: 'a', plural: 'chairs', spatial: true },
    couch: { article: 'a', plural: 'couches', spatial: true },
    'potted plant': { article: 'a', plural: 'potted plants', spatial: true },
    bed: { article: 'a', plural: 'beds', spatial: true },
    'dining table': { article: 'a', plural: 'dining tables', spatial: true },
    toilet: { article: 'a', plural: 'toilets', spatial: true },
    tv: { article: 'a', plural: 'TVs', spatial: true },
    laptop: { article: 'a', plural: 'laptops', spatial: false },
    mouse: { article: 'a', plural: 'mice', spatial: false },
    remote: { article: 'a', plural: 'remotes', spatial: false },
    keyboard: { article: 'a', plural: 'keyboards', spatial: false },
    'cell phone': { article: 'a', plural: 'cell phones', spatial: false },
    microwave: { article: 'a', plural: 'microwaves', spatial: true },
    oven: { article: 'an', plural: 'ovens', spatial: true },
    toaster: { article: 'a', plural: 'toasters', spatial: false },
    sink: { article: 'a', plural: 'sinks', spatial: true },
    refrigerator: { article: 'a', plural: 'refrigerators', spatial: true },
    book: { article: 'a', plural: 'books', spatial: false },
    clock: { article: 'a', plural: 'clocks', spatial: false },
    vase: { article: 'a', plural: 'vases', spatial: false },
    scissors: { article: 'some', plural: 'scissors', spatial: false },
    'teddy bear': { article: 'a', plural: 'teddy bears', spatial: false },
    'hair drier': { article: 'a', plural: 'hair driers', spatial: false },
    toothbrush: { article: 'a', plural: 'toothbrushes', spatial: false }
  };

  // Indoor/outdoor scene inference from objects
  const INDOOR_OBJECTS = new Set([
    'couch', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'keyboard',
    'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'chair',
    'book', 'clock', 'vase'
  ]);
  const OUTDOOR_OBJECTS = new Set([
    'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'traffic light',
    'stop sign', 'fire hydrant', 'parking meter', 'bird'
  ]);

  /**
   * Generate a full scene description from detected objects.
   * Returns the same shape as the Gemini API response.
   */
  function describeScene(detectedObjects, mode = 'detailed') {
    if (!detectedObjects || detectedObjects.length === 0) {
      return {
        description: 'I cannot detect any specific objects right now. The area appears clear ahead of you.',
        dangers: [],
        summary: 'No objects detected. Path appears clear.'
      };
    }

    // Group objects by label
    const groups = {};
    for (const obj of detectedObjects) {
      const label = obj.class || obj.label || 'object';
      if (!groups[label]) groups[label] = [];
      groups[label].push(obj);
    }

    // Infer scene type
    const sceneType = inferSceneType(Object.keys(groups));

    // Build danger list
    const dangers = buildDangers(detectedObjects);

    if (mode === 'danger') {
      if (!dangers.length) {
        return {
          description: '',
          dangers: [],
          summary: 'No immediate dangers detected. Path appears clear.'
        };
      }
      return {
        description: '',
        dangers,
        summary: dangers[0].description
      };
    }

    if (mode === 'summary') {
      return {
        description: '',
        dangers,
        summary: buildSummary(groups, sceneType)
      };
    }

    // Detailed mode
    const description = buildDetailedDescription(groups, sceneType, detectedObjects);
    return {
      description,
      dangers,
      summary: dangers.length
        ? `Caution: ${dangers[0].description}`
        : buildSummary(groups, sceneType)
    };
  }

  function inferSceneType(labels) {
    let indoorScore = 0, outdoorScore = 0;
    for (const label of labels) {
      if (INDOOR_OBJECTS.has(label)) indoorScore++;
      if (OUTDOOR_OBJECTS.has(label)) outdoorScore++;
    }
    if (outdoorScore > indoorScore) return 'outdoor';
    if (indoorScore > outdoorScore) return 'indoor';
    return 'unknown';
  }

  function buildDangers(objects) {
    const dangers = [];
    for (const obj of objects) {
      const label = obj.class || obj.label;
      const ctx = OBJECT_CONTEXT[label];
      if (!ctx || !ctx.danger) continue;
      if (obj.distanceM && obj.distanceM > 8) continue; // Too far to be dangerous

      const severity = obj.distanceM && obj.distanceM < 3 ? 'critical' : 'warning';
      const dir = obj.direction || 'ahead';
      const dist = obj.distance || (obj.distanceM ? `about ${obj.distanceM.toFixed(1)} meters` : 'nearby');
      const moveInfo = obj.moving ? `, moving ${obj.moveDir || 'toward you'}` : '';

      dangers.push({
        type: 'vehicle',
        severity,
        description: `${capitalize(label)} ${dir}, ${dist}${moveInfo}`,
        direction: dir,
        distanceM: obj.distanceM || 5
      });
    }
    dangers.sort((a, b) => (a.distanceM || 99) - (b.distanceM || 99));
    return dangers;
  }

  function buildSummary(groups, sceneType) {
    const labels = Object.keys(groups);
    if (!labels.length) return 'The area appears clear.';

    const parts = labels.map(label => {
      const count = groups[label].length;
      const ctx = OBJECT_CONTEXT[label] || { article: 'a', plural: label + 's' };
      return count > 1 ? `${count} ${ctx.plural}` : `${ctx.article} ${label}`;
    });

    const scenePrefix = sceneType === 'indoor' ? 'Indoor area with '
      : sceneType === 'outdoor' ? 'Outdoor scene with '
      : 'I can see ';

    return scenePrefix + joinNatural(parts) + '.';
  }

  function buildDetailedDescription(groups, sceneType, objects) {
    const sentences = [];

    // Opening — scene type
    if (sceneType === 'indoor') {
      sentences.push('You appear to be in an indoor space.');
    } else if (sceneType === 'outdoor') {
      sentences.push('You appear to be outdoors.');
    }

    // Group by direction for spatial awareness
    const byDirection = { ahead: [], left: [], right: [] };
    for (const obj of objects) {
      const dir = obj.direction || 'ahead';
      if (!byDirection[dir]) byDirection[dir] = [];
      byDirection[dir].push(obj);
    }

    // Describe each direction
    for (const [dir, dirObjects] of Object.entries(byDirection)) {
      if (!dirObjects.length) continue;

      const dirLabel = dir === 'ahead' ? 'Directly ahead' : `To your ${dir}`;
      const descriptions = dirObjects.map(obj => {
        const label = obj.class || obj.label;
        const dist = obj.distance || '';
        const move = obj.moving ? `, moving ${obj.moveDir || ''}` : '';
        return `${label}${dist ? ', ' + dist : ''}${move}`;
      });

      sentences.push(`${dirLabel}: ${joinNatural(descriptions)}.`);
    }

    // People count
    if (groups.person) {
      const count = groups.person.length;
      if (count === 1) {
        const p = groups.person[0];
        sentences.push(`There is one person ${p.direction || 'nearby'}, ${p.distance || 'at moderate distance'}.`);
      } else if (count <= 3) {
        sentences.push(`There are ${count} people visible around you.`);
      } else {
        sentences.push(`The area is moderately crowded with ${count} people visible.`);
      }
    }

    // Vehicle warnings
    const vehicles = objects.filter(o => {
      const ctx = OBJECT_CONTEXT[o.class || o.label];
      return ctx && ctx.moving;
    });
    if (vehicles.length) {
      const closest = vehicles.reduce((a, b) => (a.distanceM || 99) < (b.distanceM || 99) ? a : b);
      if (closest.distanceM && closest.distanceM < 5) {
        sentences.push(`Watch out — ${closest.class || closest.label} is close, ${closest.distance || 'nearby'}.`);
      }
    }

    return sentences.join(' ') || 'I can see some objects around you but cannot determine specific details offline.';
  }

  // Helpers
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function joinNatural(arr) {
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
    return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
  }

  return { describeScene };
})();
