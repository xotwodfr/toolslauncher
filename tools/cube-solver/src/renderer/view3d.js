// The 3D puzzle (three.js, bundled locally), built from the puzzle module's sticker polygons (puzzle-core.js).
//
// Cube-shaped puzzles (cubes and cuboids) are black plastic cubies with rounded stickers. Other shapes (Pyraminx, Megaminx,
// ...) are a dark plastic body (the solid shape itself) with a raised dark tile under every sticker, so the seams between the
// pieces show as grooves. A turn moves the pieces of one layer (puzzle.turns[name].moving) into a pivot and rotates it about
// the turn's axis; for the solid body the layer's part of the body is cut off with clipping planes and turns with it, so the
// inside never shows. When the turn ends everything goes back home and every sticker is recoloured from the state model, so
// the picture can never drift from the model. readBack() reads the colours off the 3D scene itself (each sticker's world
// position and normal -> sticker index), which is what the end-to-end test checks.
import * as THREE from '../../node_modules/three/build/three.module.min.js';

const DEFAULT_FRONT = { theta: 0.52, phi: 0.43 };
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// ---- small geometry helpers ---------------------------------------------------------------------------------------------------
function area2d(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
/** Moves every edge of a convex polygon inwards by d (pts anticlockwise). */
function insetPolygon(pts, d) {
  const n = pts.length;
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const ex = q[0] - p[0]; const ey = q[1] - p[1]; const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len; const ny = ex / len; // inward for an anticlockwise polygon
    return { p: [p[0] + nx * d, p[1] + ny * d], dir: [ex / len, ey / len] };
  });
  return lines.map((l, i) => {
    const m = lines[(i + n - 1) % n];
    const den = m.dir[0] * l.dir[1] - m.dir[1] * l.dir[0];
    if (Math.abs(den) < 1e-9) return l.p;
    const t = ((l.p[0] - m.p[0]) * l.dir[1] - (l.p[1] - m.p[1]) * l.dir[0]) / den;
    return [m.p[0] + m.dir[0] * t, m.p[1] + m.dir[1] * t];
  });
}
/** A convex polygon, its edges moved in by `gap`, with round corners of radius r. */
function roundedShape(pts, gap, r) {
  if (area2d(pts) < 0) pts = pts.slice().reverse();
  const inner = insetPolygon(pts, gap + r);
  const n = inner.length;
  const s = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const p = inner[i]; const a = inner[(i + n - 1) % n]; const b = inner[(i + 1) % n];
    const a1 = Math.atan2(-(p[0] - a[0]), p[1] - a[1]); // outward normal of the edge a->p
    let a2 = Math.atan2(-(b[0] - p[0]), b[1] - p[1]);   // outward normal of the edge p->b
    while (a2 < a1) a2 += Math.PI * 2;
    if (i === 0) s.moveTo(p[0] + r * Math.cos(a1), p[1] + r * Math.sin(a1));
    s.absarc(p[0], p[1], r, a1, a2, false);
  }
  s.closePath();
  return s;
}
const polyArea3 = (poly) => { const c = new THREE.Vector3(); for (let i = 1; i + 1 < poly.length; i++) c.add(new THREE.Vector3().crossVectors(v3(poly[i]).sub(v3(poly[0])), v3(poly[i + 1]).sub(v3(poly[0])))); return c.length() / 2; };

export function createView(container, canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101013');
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(4, 7, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7); fill.position.set(-6, -2, -4); scene.add(fill);

  const root = new THREE.Group();
  scene.add(root);
  const plastic = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide });
  const plasticMoving = plastic.clone();
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x060607, roughness: 0.7, metalness: 0.0, side: THREE.DoubleSide });
  const coreMovingMat = coreMat.clone();
  const noneMat = new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: 0.8 });
  let mats = {}; let colourOfMat = new Map();

  let def = null; let P = null;
  let pieces = [];      // { obj, stickers: [i], home: Vector3, homeQ, tile }
  let stickers = [];    // per sticker index: { mesh, lift, normal }
  let core = null; let coreMoving = null; let cubeShaped = false; let unit = 1;
  let state = [];
  let front = { ...DEFAULT_FRONT };
  let view = { ...DEFAULT_FRONT }; let mode = 'front'; let dist = 10;
  let animating = null; let dirty = true;

  let current = null; // the running turn: { pivot, finish }
  function clear() {
    if (current) current.finish(); // a turn still running ends at once (its pieces go home first)
    for (const p of pieces) root.remove(p.obj);
    if (core) root.remove(core);
    if (coreMoving) root.remove(coreMoving);
    pieces = []; stickers = []; core = null; coreMoving = null;
  }

  function stickerMesh(s, centre, normal, lift, size) {
    // the sticker's own 2D frame: local z along the normal; `centre` is where the sticker's centre is in its parent
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q); const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const pts = s.poly.map((p) => { const d = v3(p).sub(v3(s.centre)); return [d.dot(ax), d.dot(ay)]; });
    const tri = pts.length === 3;
    const shape = roundedShape(pts, 0.08 * size, (tri ? 0.07 : 0.12) * size);
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 4), noneMat);
    mesh.quaternion.copy(q);
    mesh.position.copy(centre).addScaledVector(normal, lift);
    return mesh;
  }

  /** Cubes and cuboids: every face axis-aligned and every sticker an axis-aligned rectangle. */
  function isCubeShaped(puz) {
    if (puz.faces.length !== 6) return false;
    const axisOf = (n) => { const k = n.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-6); return k >= 0 && n.every((v, j) => j === k || Math.abs(v) < 1e-6) ? k : -1; };
    if (puz.faces.some((f) => axisOf(f.normal) < 0)) return false;
    return puz.stickers.every((s) => s.poly.length === 4 && s.poly.every((p, i) => { const q = s.poly[(i + 1) % 4]; return [0, 1, 2].filter((k) => Math.abs(p[k] - q[k]) > 1e-6).length === 1; }));
  }

  function buildCubies() {
    const axisOf = (n) => n.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-6);
    // the size of a cell along each axis, from the stickers that lie along it
    const cell = [0, 1, 2].map((k) => {
      const ext = P.stickers.filter((s) => axisOf(s.normal) !== k).map((s) => Math.max(...s.poly.map((p) => p[k])) - Math.min(...s.poly.map((p) => p[k]))).sort((a, b) => a - b);
      return ext.length ? ext[ext.length >> 1] : 1;
    });
    unit = Math.min(...cell);
    const keyOf = (p) => p.map((v) => Math.round(v * 1000)).join(',');
    const byKey = new Map();
    const coords = [new Set(), new Set(), new Set()];
    const addCubie = (centre) => {
      const k = keyOf(centre);
      if (byKey.has(k)) return byKey.get(k);
      const obj = new THREE.Group();
      obj.position.set(centre[0], centre[1], centre[2]);
      obj.add(new THREE.Mesh(new THREE.BoxGeometry(cell[0] * 0.97, cell[1] * 0.97, cell[2] * 0.97), plastic));
      root.add(obj);
      const pc = { obj, stickers: [], home: obj.position.clone(), centre };
      byKey.set(k, pc); pieces.push(pc);
      return pc;
    };
    for (const s of P.stickers) {
      const k = axisOf(s.normal);
      const centre = s.centre.map((v, j) => v - s.normal[j] * cell[k] / 2);
      const pc = addCubie(centre);
      centre.forEach((v, j) => coords[j].add(Math.round(v * 1000) / 1000));
      const nrm = v3(s.normal);
      const size = Math.sqrt(polyArea3(s.poly));
      // the sticker sits just above the cubie's plastic (0.485 of a cell from its centre)
      const mesh = stickerMesh(s, v3(s.centre).sub(pc.home), nrm, -0.013 * cell[k], size);
      pc.obj.add(mesh);
      pc.stickers.push(s.i);
      stickers[s.i] = { mesh, lift: -0.013 * cell[k], normal: nrm };
    }
    // the cubies with no sticker (inside), so a turning layer never shows a hole
    const cs = coords.map((set) => [...set].sort((a, b) => a - b));
    for (const x of cs[0]) for (const y of cs[1]) for (const z of cs[2]) if (!byKey.has(keyOf([x, y, z]))) addCubie([x, y, z]);
  }

  function buildSolid() {
    // the body: every face's outline, as a closed solid; and a dark tile under every sticker
    const geo = new THREE.BufferGeometry();
    const pos = [];
    for (const f of P.faces) {
      const own = P.stickers.filter((s) => s.face === f.id);
      const n = v3(f.normal); const up = v3(f.up); const right = new THREE.Vector3().crossVectors(up, n);
      const o = new THREE.Vector3(); own.forEach((s) => o.add(v3(s.centre))); o.multiplyScalar(1 / own.length);
      const pts2 = []; for (const s of own) for (const p of s.poly) { const d = v3(p).sub(o); pts2.push([d.dot(right), d.dot(up)]); }
      const hull = hull2(pts2);
      const to3 = ([x, y]) => o.clone().addScaledVector(right, x).addScaledVector(up, y);
      for (let i = 1; i + 1 < hull.length; i++) for (const p of [hull[0], hull[i], hull[i + 1]]) { const v = to3(p); pos.push(v.x, v.y, v.z); }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    core = new THREE.Mesh(geo, coreMat);
    coreMoving = new THREE.Mesh(geo, coreMovingMat);
    coreMoving.visible = false;
    root.add(core); root.add(coreMoving);
    const sizes = P.stickers.map((s) => Math.sqrt(polyArea3(s.poly)));
    unit = sizes.slice().sort((a, b) => a - b)[sizes.length >> 1];
    for (const s of P.stickers) {
      const size = sizes[s.i];
      const nrm = v3(s.normal);
      const centre = v3(s.centre);
      const obj = new THREE.Group();
      // tile: the cell a little smaller (the seams), raised a little, reaching a little into the body
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
      const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q); const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      let pts = s.poly.map((p) => { const d = v3(p).sub(centre); return [d.dot(ax), d.dot(ay)]; });
      if (area2d(pts) < 0) pts = pts.reverse();
      const shape = new THREE.Shape(insetPolygon(pts, 0.025 * size).map(([x, y]) => new THREE.Vector2(x, y)));
      const h = 0.05 * size; const below = 0.06 * size;
      const tileGeo = new THREE.ExtrudeGeometry(shape, { depth: h + below, bevelEnabled: false });
      tileGeo.translate(0, 0, -below);
      const tile = new THREE.Mesh(tileGeo, plastic);
      tile.quaternion.copy(q); tile.position.copy(centre);
      obj.add(tile);
      const mesh = stickerMesh(s, centre, nrm, h + 0.004 * size, size);
      obj.add(mesh);
      root.add(obj);
      pieces.push({ obj, stickers: [s.i], home: new THREE.Vector3(), tile });
      stickers[s.i] = { mesh, lift: h + 0.004 * size, normal: nrm };
    }
  }

  function build(d) {
    clear();
    def = d; P = d.puzzle;
    mats = {}; colourOfMat = new Map();
    for (const [k, c] of Object.entries(P.colours)) { mats[k] = new THREE.MeshStandardMaterial({ color: new THREE.Color(c.hex), roughness: 0.38, metalness: 0.0 }); colourOfMat.set(mats[k], k); }
    colourOfMat.set(noneMat, null);
    cubeShaped = isCubeShaped(P);
    if (cubeShaped) buildCubies(); else buildSolid();
    let R = 0; for (const s of P.stickers) for (const p of s.poly) R = Math.max(R, Math.hypot(p[0], p[1], p[2]));
    dist = (def.view3d && def.view3d.distance) || R * 4.31;
    front = { ...DEFAULT_FRONT };
    if (!cubeShaped) {
      // look at the first face of the scan (the "front") from a little above and to the right
      const fid = (def.scan && def.scan.faces && def.scan.faces[0] && def.scan.faces[0].face) || P.faces[0].id;
      const n = P.faceById.get(fid).normal;
      const tri = P.stickers.find((st) => st.face === fid).poly.length === 3; // a tetrahedron shows two faces from between them
      front = { theta: Math.atan2(n[0], n[2]) + (tri ? 1.0 : 0.42), phi: Math.max(-1.2, Math.min(1.2, Math.asin(n[1]) + (tri ? 0.2 : 0.3))) };
    }
    if (def.view3d && def.view3d.front) Object.assign(front, def.view3d.front);
    if (mode === 'front') { view = { ...front }; viewAnim = null; }
    placeCamera();
  }

  function paint(colours) {
    state = Array.from(colours);
    for (let i = 0; i < stickers.length; i++) stickers[i].mesh.material = mats[state[i]] || noneMat;
    dirty = true;
  }

  function placeCamera() {
    const { theta, phi } = view;
    camera.position.set(dist * Math.cos(phi) * Math.sin(theta), dist * Math.sin(phi), dist * Math.cos(phi) * Math.cos(theta));
    camera.lookAt(0, 0, 0);
    dirty = true;
  }

  function resize() {
    const w = Math.max(10, container.clientWidth); const h = Math.max(10, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(container);

  // orbit by dragging
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    drag = { x: e.clientX, y: e.clientY };
    view.theta -= dx * 0.01;
    view.phi = Math.max(-1.45, Math.min(1.45, view.phi + dy * 0.01));
    if (mode !== 'free') { mode = 'free'; api.onModeChange && api.onModeChange('free'); }
    placeCamera();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

  let viewAnim = null;
  function setMode(m) {
    mode = m;
    if (m === 'front') {
      const from = { ...view }; const t0 = performance.now();
      let dt = front.theta - from.theta; dt = Math.atan2(Math.sin(dt), Math.cos(dt)); // the shortest way round
      viewAnim = (now) => {
        const t = Math.min(1, (now - t0) / 350); const e = t * (2 - t);
        view.theta = from.theta + dt * e; view.phi = from.phi + (front.phi - from.phi) * e;
        placeCamera();
        if (t >= 1) viewAnim = null;
      };
    }
  }

  /** Where the turning layer is cut off from the rest: clipping planes for the moving part and for the rest. */
  function cutPlanes(t, movingSet) {
    const a = v3(t.axis);
    let lo = Infinity; let hi = -Infinity; let sLo = Infinity; let sHi = -Infinity;
    for (const s of P.stickers) {
      for (const p of s.poly) {
        const d = a.x * p[0] + a.y * p[1] + a.z * p[2];
        if (movingSet.has(s.i)) { lo = Math.min(lo, d); hi = Math.max(hi, d); } else { sLo = Math.min(sLo, d); sHi = Math.max(sHi, d); }
      }
    }
    if (sLo === Infinity) return null; // the whole puzzle turns
    const eps = 1e-6 * dist;
    const na = a.clone().negate();
    if (sHi <= lo + eps) return { moving: [new THREE.Plane(a, -lo)], rest: [new THREE.Plane(na, lo)], restUnion: false };
    if (sLo >= hi - eps) return { moving: [new THREE.Plane(na, hi)], rest: [new THREE.Plane(a, -hi)], restUnion: false };
    return { moving: [new THREE.Plane(a, -lo), new THREE.Plane(na, hi)], rest: [new THREE.Plane(na, lo), new THREE.Plane(a, -hi)], restUnion: true };
  }
  function setClipping(cut) {
    for (const [m, planes, union] of [[plastic, cut && cut.rest, cut && cut.restUnion], [coreMat, cut && cut.rest, cut && cut.restUnion], [plasticMoving, cut && cut.moving, false], [coreMovingMat, cut && cut.moving, false]]) {
      m.clippingPlanes = planes || null; m.clipIntersection = !!union; m.needsUpdate = true;
    }
  }

  /** Turns one layer on screen. move = { turn, amount }. Resolves when done; the stickers then show `after`. */
  function animateMove(move, ms, after) {
    return new Promise((resolve) => {
      const t = P.turns[move.turn];
      if (!t) { paint(after); resolve(); return; }
      const movingSet = new Set(t.moving);
      const axis = v3(t.axis);
      let k = ((move.amount % t.order) + t.order) % t.order;
      if (k > t.order / 2) k -= t.order; // the short way round
      const pivot = new THREE.Group();
      root.add(pivot);
      let layer;
      let cut = null;
      if (cubeShaped) {
        layer = pieces.filter((pc) => pc.stickers.some((i) => movingSet.has(i)));
        // cubies with no sticker move when their layer does
        const proj = (pc) => Math.round(pc.home.dot(axis) * 1000);
        const movingProj = new Set(layer.map(proj));
        const restProj = new Set(pieces.filter((pc) => pc.stickers.length && !layer.includes(pc)).map(proj));
        for (const pc of pieces) if (!pc.stickers.length && movingProj.has(proj(pc)) && !restProj.has(proj(pc))) layer.push(pc);
      } else {
        layer = pieces.filter((pc) => movingSet.has(pc.stickers[0]));
        cut = cutPlanes(t, movingSet);
        if (cut) {
          setClipping(cut);
          for (const pc of layer) pc.tile.material = plasticMoving;
          coreMoving.visible = true;
          pivot.attach(coreMoving);
        } else pivot.attach(core);
      }
      for (const pc of layer) pivot.attach(pc.obj);
      const total = t.angle * k; // t.angle = one step clockwise seen from outside
      const t0 = performance.now();
      const dur = Math.max(1, ms * (Math.abs(k) >= 2 ? 1.5 : 1));
      const finish = () => {
        for (const pc of layer) { root.attach(pc.obj); pc.obj.position.copy(pc.home); pc.obj.quaternion.identity(); if (pc.tile) pc.tile.material = plastic; }
        if (!cubeShaped) {
          root.attach(core); core.position.set(0, 0, 0); core.quaternion.identity();
          root.attach(coreMoving); coreMoving.position.set(0, 0, 0); coreMoving.quaternion.identity(); coreMoving.visible = false;
          setClipping(null);
        }
        root.remove(pivot);
        animating = null; current = null;
        resolve();
      };
      current = { pivot, finish };
      animating = (now) => {
        const x = Math.min(1, (now - t0) / dur);
        const e = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
        pivot.quaternion.setFromAxisAngle(axis, total * e);
        if (x >= 1) {
          finish();
          paint(after);
          return;
        }
      };
      dirty = true;
    });
  }

  function frame(now) {
    if (animating) { animating(now); dirty = true; }
    if (viewAnim) viewAnim(now);
    if (dirty) { renderer.render(scene, camera); dirty = false; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** The colours as the 3D scene shows them, in sticker order (from each sticker's world position and normal). */
  function readBack() {
    if (!P) return null;
    const out = new Array(P.size).fill(undefined);
    const p = new THREE.Vector3(); const q = new THREE.Quaternion();
    root.updateMatrixWorld(true);
    const tol = 0.05 * unit;
    for (const st of stickers) {
      st.mesh.getWorldPosition(p); st.mesh.getWorldQuaternion(q);
      const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const c = p.clone().addScaledVector(nrm, -st.lift);
      let best = -1; let bd = Infinity;
      for (const s of P.stickers) {
        if (s.normal[0] * nrm.x + s.normal[1] * nrm.y + s.normal[2] * nrm.z < 0.99) continue;
        const d = Math.hypot(s.centre[0] - c.x, s.centre[1] - c.y, s.centre[2] - c.z);
        if (d < bd) { bd = d; best = s.i; }
      }
      if (best < 0 || bd > tol || out[best] !== undefined) return null;
      out[best] = colourOfMat.get(st.mesh.material);
    }
    return out;
  }

  const api = {
    /** Shows this puzzle (a puzzle module) with these colours. */
    setPuzzle(d, colours) { if (d !== def) build(d); paint(colours); },
    paint, animateMove, setMode, readBack,
    isAnimating: () => !!animating,
    mode: () => mode,
    angles: () => ({ mode, view: { ...view }, front: { ...front }, dist }),
    onModeChange: null,
  };
  resize();
  return api;
}

function hull2(points) {
  const pts = points.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossZ = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = []; const upper = [];
  for (const p of pts) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
