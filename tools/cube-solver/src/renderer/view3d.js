// The 3D cube (three.js, bundled locally). Black plastic cubies with rounded stickers; a turn moves the cubies of one layer
// into a pivot and rotates it about the face's axis, then puts them back home and recolours every sticker from the state
// model, so the picture can never drift from the model. readBack() reads the colours off the 3D scene itself (sticker world
// positions and normals -> sticker index), which is what the end-to-end test checks.
import * as THREE from '../../node_modules/three/build/three.module.min.js';

const C = window.CubeModel;
const FRONT = { theta: 0.52, phi: 0.43 };

export function createView(container, canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  } catch (e) {
    return null;
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101013');
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(4, 7, 6); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7); fill.position.set(-6, -2, -4); scene.add(fill);

  const root = new THREE.Group();
  scene.add(root);
  const plastic = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.55, metalness: 0.0 });
  const mats = {};
  for (const c of C.COLOURS) mats[c] = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.COLOUR_HEX[c]), roughness: 0.38, metalness: 0.0 });
  mats.none = new THREE.MeshStandardMaterial({ color: 0x3a3a42, roughness: 0.8 });
  const colourOfMat = new Map(Object.entries(mats).map(([k, m]) => [m, k === 'none' ? null : k]));

  let n = 0; let g = null; let cubies = []; let stickers = []; let state = [];
  let view = { ...FRONT }; let mode = 'front'; let dist = 10;
  let animating = null; let dirty = true;

  function roundedSquare(size, r) {
    const s = new THREE.Shape(); const h = size / 2;
    s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.quadraticCurveTo(h, -h, h, -h + r); s.lineTo(h, h - r); s.quadraticCurveTo(h, h, h - r, h);
    s.lineTo(-h + r, h); s.quadraticCurveTo(-h, h, -h, h - r); s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
    return new THREE.ShapeGeometry(s, 4);
  }

  function build(size) {
    for (const c of cubies) root.remove(c.obj);
    n = size; g = C.geometry(n); cubies = []; stickers = new Array(g.size);
    const box = new THREE.BoxGeometry(0.97, 0.97, 0.97);
    const face = roundedSquare(0.84, 0.12);
    const byPos = new Map();
    for (const s of g.stickers) {
      const k = s.pos.join(',');
      if (!byPos.has(k)) {
        const obj = new THREE.Group();
        obj.position.set(...s.pos);
        obj.add(new THREE.Mesh(box, plastic));
        root.add(obj);
        const c = { obj, home: new THREE.Vector3(...s.pos) };
        byPos.set(k, c); cubies.push(c);
      }
      const c = byPos.get(k);
      const m = new THREE.Mesh(face, mats.none);
      const nrm = new THREE.Vector3(...s.normal);
      m.position.copy(nrm.clone().multiplyScalar(0.487));
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
      c.obj.add(m);
      stickers[s.i] = m;
    }
    dist = n === 3 ? 11.2 : 8;
    placeCamera();
  }

  function paint(colours) {
    state = Array.from(colours);
    for (let i = 0; i < stickers.length; i++) stickers[i].material = mats[state[i]] || mats.none;
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
      // the shortest way round
      let dt = FRONT.theta - from.theta; dt = Math.atan2(Math.sin(dt), Math.cos(dt));
      viewAnim = (now) => {
        const t = Math.min(1, (now - t0) / 350); const e = t * (2 - t);
        view.theta = from.theta + dt * e; view.phi = from.phi + (FRONT.phi - from.phi) * e;
        placeCamera();
        if (t >= 1) viewAnim = null;
      };
    }
  }

  /** Turns one layer on screen. Resolves when done; the stickers then show `after`. */
  function animateMove(move, ms, after) {
    return new Promise((resolve) => {
      const face = move[0];
      const amount = move.endsWith('2') ? 2 : move.endsWith("'") ? -1 : 1;
      const axis = new THREE.Vector3(...C.AXIS[face]);
      const m = (n - 1) / 2;
      const pivot = new THREE.Group();
      root.add(pivot);
      const layer = cubies.filter((c) => Math.abs(c.home.dot(axis) - m) < 1e-6);
      for (const c of layer) pivot.attach(c.obj);
      const total = -amount * Math.PI / 2; // clockwise seen from outside = negative about the outward axis
      const t0 = performance.now();
      const dur = Math.max(1, ms * (Math.abs(amount) === 2 ? 1.5 : 1));
      animating = (now) => {
        const t = Math.min(1, (now - t0) / dur);
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        pivot.quaternion.setFromAxisAngle(axis, total * e);
        if (t >= 1) {
          for (const c of layer) { root.attach(c.obj); c.obj.position.copy(c.home); c.obj.quaternion.identity(); }
          root.remove(pivot);
          animating = null;
          paint(after);
          resolve();
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
    const out = new Array(g.size).fill(undefined);
    const p = new THREE.Vector3(); const q = new THREE.Quaternion();
    root.updateMatrixWorld(true);
    for (const m of stickers) {
      m.getWorldPosition(p); m.getWorldQuaternion(q);
      const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const nr = [nrm.x, nrm.y, nrm.z].map((v) => Math.round(v));
      const pos = [p.x - nrm.x * 0.487, p.y - nrm.y * 0.487, p.z - nrm.z * 0.487];
      const k = pos.map((v) => Math.round(v * 2)).join(',') + '|' + nr.join(',');
      const i = g.index.get(k);
      if (i == null) return null;
      out[i] = colourOfMat.get(m.material);
    }
    return out;
  }

  const api = {
    setCube(size, colours) { if (size !== n) build(size); paint(colours); },
    paint, animateMove, setMode, readBack,
    isAnimating: () => !!animating,
    mode: () => mode,
    onModeChange: null,
  };
  resize();
  return api;
}
