'use strict';
(() => {
  const pb = window.pb;
  const R = window.Recipe;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pb.' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  };
  const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const plain = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  let uid = 1;
  const withIds = (recipe) => recipe.map((s) => ({ ...s, _id: uid++ }));
  const S = {
    rows: [], byId: new Map(), current: null,
    recipe: withIds(R.cleanRecipe(store.get('recipe', null) || R.DEFAULT_RECIPE())),
    output: { ...R.DEFAULT_OUTPUT, ...R.cleanOutput(store.get('output', {})) },
    presets: {}, mode: store.get('mode', 'side'), running: false, logoNames: store.get('logoNames', {}),
  };
  const recipeOut = () => S.recipe.map(({ _id, ...s }) => s);
  const saveState = () => { store.set('recipe', recipeOut()); store.set('output', S.output); };

  // ---- messages ------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }

  // ---- photo list ------------------------------------------------------------------------------------------------------------
  function addRows(res) {
    const fresh = (res.rows || []).filter((r) => !S.byId.has(r.id));
    for (const r of fresh) {
      const row = { ...r, status: '', error: r.problem || '', out: '' };
      row.img = el('img', { alt: '' }); row.stEl = el('span', { class: 'st' }); row.errEl = el('div', { class: 'err trunc' });
      row.btn = el('button', { class: 'item', role: 'option', 'aria-selected': 'false', 'data-id': String(r.id), title: r.name },
        row.img,
        el('div', { class: 'info' }, el('div', { class: 'n trunc' }, r.name), el('div', { class: 'd trunc' }, r.width ? `${r.width} × ${r.height} · ${fmtBytes(r.bytes)}` : fmtBytes(r.bytes)), row.errEl),
        row.stEl);
      row.btn.addEventListener('click', () => select(r.id));
      S.rows.push(row); S.byId.set(r.id, row);
      paintRow(row);
    }
    if (res.capped) toast('That is the most photos the list can hold (10 000)', true);
    else if (res.ignored) toast('No photos there that this tool can read', true);
    else if (fresh.length) toast(`Added ${fresh.length} photo${fresh.length > 1 ? 's' : ''}`);
    paintList();
    loadThumbs(fresh);
    if (!S.current && S.rows.length) select(S.rows.find((r) => !r.problem)?.id || S.rows[0].id);
    return fresh.length;
  }
  async function loadThumbs(rows) {
    let i = 0;
    const work = async () => {
      while (i < rows.length) {
        const r = S.byId.get(rows[i++].id);
        if (!r || r.problem) continue;
        const src = await pb.thumb(r.id);
        if (src) r.img.src = src;
      }
    };
    await Promise.all([work(), work(), work()]);
  }
  function paintRow(r) {
    const label = { working: 'Working', done: 'Done', error: 'Failed', cancelled: 'Skipped' }[r.status] || '';
    r.stEl.textContent = label; r.stEl.className = 'st ' + r.status;
    r.errEl.textContent = r.error; r.errEl.hidden = !r.error;
    r.btn.title = r.error ? `${r.name}: ${r.error}` : r.out ? `${r.name} → ${r.outName}` : r.name;
  }
  function paintList() {
    const list = $('list');
    if (list.children.length !== S.rows.length) list.replaceChildren(...S.rows.map((r) => r.btn));
    const n = S.rows.length;
    $('count').textContent = n ? String(n) : '';
    $('empty').hidden = n > 0; list.hidden = n === 0;
    $('clear').hidden = n === 0 || S.running; $('removeSel').hidden = !S.current || S.running;
    paintStart();
  }
  function select(id) {
    const r = S.byId.get(id); if (!r) return;
    S.current = id;
    for (const x of S.rows) { x.btn.classList.toggle('sel', x.id === id); x.btn.setAttribute('aria-selected', String(x.id === id)); }
    $('pvName').textContent = r.name;
    paintList(); paintPatternExample();
    schedulePreview(0);
  }
  async function addFrom(fn) { try { addRows(await fn()); } catch (e) { toast(plain(e), true); } }
  async function removeCurrent() {
    if (!S.current || S.running) return;
    const id = S.current; const idx = S.rows.findIndex((r) => r.id === id);
    await pb.remove([id]);
    S.rows.splice(idx, 1); S.byId.delete(id); S.current = null;
    paintList();
    const next = S.rows[Math.min(idx, S.rows.length - 1)];
    if (next) select(next.id); else clearPreview();
  }
  async function clearAll() {
    if (S.running) return;
    await pb.clear();
    S.rows = []; S.byId.clear(); S.current = null;
    paintList(); clearPreview();
  }

  // ---- preview -------------------------------------------------------------------------------------------------------------------
  let pvTimer = null; let pvSeq = 0; let pvShown = 0;
  function clearPreview() {
    for (const id of ['imgBefore', 'imgAfter', 'sBefore', 'sAfter']) $(id).removeAttribute('src');
    $('stage').classList.add('none'); $('pvEmpty').hidden = false; $('pvSize').textContent = ''; $('pvName').textContent = '';
  }
  function schedulePreview(ms = 250) { clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, ms); }
  async function renderPreview() {
    const r = S.byId.get(S.current);
    if (!r) { clearPreview(); return; }
    if (r.problem) { clearPreview(); $('pvEmpty').hidden = false; $('pvEmpty').textContent = `${r.name}: ${r.problem}`; return; }
    const seq = ++pvSeq;
    $('pvBusy').hidden = false;
    const st = $('stage').getBoundingClientRect();
    const box = Math.round(Math.max(st.width / (S.mode === 'side' ? 2 : 1), st.height) * Math.min(2, window.devicePixelRatio || 1));
    try {
      const p = await pb.preview(r.id, recipeOut(), S.output, box);
      if (seq !== pvSeq) return;
      $('imgBefore').src = p.before; $('imgAfter').src = p.after; $('sBefore').src = p.before; $('sAfter').src = p.after;
      $('stage').classList.remove('none'); $('pvEmpty').hidden = true;
      $('pvSize').textContent = `${r.width} × ${r.height} → ${p.width} × ${p.height} · ${R.FORMATS[p.format] || p.format.toUpperCase()}`;
      pvShown = seq;
      requestAnimationFrame(syncSlider);
    } catch (e) {
      if (seq === pvSeq) { $('pvSize').textContent = ''; toast(plain(e), true); }
    } finally { if (seq === pvSeq) $('pvBusy').hidden = true; }
  }
  function setMode(m) {
    S.mode = m; store.set('mode', m);
    $('stage').classList.toggle('side', m === 'side'); $('stage').classList.toggle('slide', m === 'slider');
    $('modeSide').setAttribute('aria-checked', String(m === 'side')); $('modeSlider').setAttribute('aria-checked', String(m === 'slider'));
    requestAnimationFrame(syncSlider);
  }
  function syncSlider() {
    const v = Number($('sRange').value);
    const img = $('sBefore');
    $('sclip').style.width = v + '%';
    $('shandle').style.left = `calc(${v}% - 1px)`;
    $('sAfter').style.height = img.clientHeight + 'px';
    $('sAfter').style.width = img.clientWidth + 'px';
  }

  // ---- the recipe -------------------------------------------------------------------------------------------------------------------
  const POS_LABEL = { 'top-left': 'Top left', top: 'Top', 'top-right': 'Top right', left: 'Left', centre: 'Centre', right: 'Right', 'bottom-left': 'Bottom left', bottom: 'Bottom', 'bottom-right': 'Bottom right' };
  const positions = Object.entries(POS_LABEL);
  // the controls of each kind of step: [key, kind, label, options or {min,max,step,unit}, show-if]
  const FIELDS = {
    resize: [
      ['mode', 'select', 'Size by', [['long', 'Long edge'], ['exact', 'Exact size'], ['percent', 'Percent']]],
      ['long', 'number', 'Long edge', { min: 1, max: 30000, unit: 'px' }, (s) => s.mode === 'long'],
      ['width', 'number', 'Width', { min: 1, max: 30000, unit: 'px' }, (s) => s.mode === 'exact'],
      ['height', 'number', 'Height', { min: 1, max: 30000, unit: 'px' }, (s) => s.mode === 'exact'],
      ['fit', 'select', 'Fit', [['inside', 'Fit inside'], ['cover', 'Fill and crop'], ['fill', 'Stretch']], (s) => s.mode === 'exact'],
      ['percent', 'number', 'Percent', { min: 1, max: 400, step: 1, unit: '%' }, (s) => s.mode === 'percent'],
      ['noUpscale', 'check', 'Never make photos bigger'],
    ],
    crop: [
      ['aspect', 'select', 'Shape', [['1:1', '1:1 square'], ['4:5', '4:5 portrait'], ['5:4', '5:4'], ['3:2', '3:2 photo'], ['2:3', '2:3 tall'], ['4:3', '4:3'], ['16:9', '16:9 wide'], ['9:16', '9:16 story'], ['custom', 'Custom…']]],
      ['customW', 'number', 'Width part', { min: 0.01, max: 1000, step: 0.01 }, (s) => s.aspect === 'custom'],
      ['customH', 'number', 'Height part', { min: 0.01, max: 1000, step: 0.01 }, (s) => s.aspect === 'custom'],
      ['anchor', 'select', 'Keep', [['centre', 'The centre'], ['attention', 'The subject (smart)'], ['top', 'The top'], ['bottom', 'The bottom'], ['left', 'The left'], ['right', 'The right']]],
      ['matchOrientation', 'check', 'Turn the shape for upright photos'],
    ],
    rotate: [
      ['angle', 'range', 'Angle', { min: -180, max: 180, step: 1, unit: '°' }],
      ['flipH', 'check', 'Mirror left to right'],
      ['flipV', 'check', 'Flip upside down'],
      ['background', 'colour', 'Corners', null, (s) => s.angle % 90 !== 0],
    ],
    levels: [['strength', 'select', 'Strength', [['gentle', 'Gentle'], ['normal', 'Normal'], ['strong', 'Strong']]]],
    adjust: [
      ['brightness', 'range', 'Brightness', { min: -100, max: 100, step: 1 }],
      ['contrast', 'range', 'Contrast', { min: -100, max: 100, step: 1 }],
      ['saturation', 'range', 'Saturation', { min: -100, max: 100, step: 1 }],
      ['warmth', 'range', 'Warmth', { min: -100, max: 100, step: 1 }],
    ],
    sharpen: [['amount', 'select', 'Amount', [['light', 'Light'], ['medium', 'Medium'], ['strong', 'Strong']]]],
    tone: [['mode', 'select', 'Look', [['grayscale', 'Black & white'], ['sepia', 'Sepia']]]],
    border: [['size', 'range', 'Width', { min: 0, max: 20, step: 0.5, unit: '%' }], ['colour', 'colour', 'Colour']],
    text: [
      ['text', 'text', 'Text'],
      ['size', 'range', 'Size', { min: 1, max: 15, step: 0.5, unit: '%' }],
      ['colour', 'colour', 'Colour'],
      ['opacity', 'range', 'Opacity', { min: 0, max: 100, step: 1, unit: '%' }],
      ['position', 'select', 'Where', positions],
      ['margin', 'range', 'Margin', { min: 0, max: 15, step: 0.5, unit: '%' }],
      ['bold', 'check', 'Bold'],
      ['shadow', 'check', 'Soft shadow (readable on light photos)'],
    ],
    logo: [
      ['file', 'file', 'Logo'],
      ['scale', 'range', 'Width', { min: 2, max: 60, step: 1, unit: '%' }],
      ['opacity', 'range', 'Opacity', { min: 0, max: 100, step: 1, unit: '%' }],
      ['position', 'select', 'Where', positions],
      ['margin', 'range', 'Margin', { min: 0, max: 15, step: 0.5, unit: '%' }],
    ],
    corners: [['radius', 'range', 'Radius', { min: 0, max: 50, step: 0.5, unit: '%' }], ['background', 'colour', 'JPEG corners']],
  };

  function changed(rebuild = false) {
    saveState();
    if (rebuild) paintSteps();
    else paintShowIf();
    schedulePreview();
    paintPatternExample();
  }
  function paintShowIf() {
    for (const s of S.recipe) {
      const card = document.querySelector(`.step[data-id="${s._id}"]`);
      if (!card) continue;
      card.classList.toggle('off', !s.on);
      for (const [key, , , , showIf] of FIELDS[s.type]) {
        const parts = card.querySelectorAll(`[data-key="${key}"]`);
        parts.forEach((p) => { p.hidden = showIf ? !showIf(s) : false; });
      }
    }
  }
  function control(s, [key, kind, label, opt]) {
    const id = `f${s._id}-${key}`;
    const set = (v) => { s[key] = v; changed(); };
    let ctl; let val = null;
    if (kind === 'select') {
      ctl = el('select', { id }, ...opt.map(([v, t]) => el('option', { value: v }, t)));
      ctl.value = String(s[key]);
      ctl.addEventListener('change', () => set(typeof R.STEPS[s.type].defaults[key] === 'number' ? Number(ctl.value) : ctl.value));
    } else if (kind === 'number') {
      ctl = el('input', { id, type: 'number', min: String(opt.min), max: String(opt.max), step: String(opt.step || 1), value: String(s[key]) });
      ctl.addEventListener('change', () => { const v = Number(ctl.value); if (!Number.isFinite(v) || v < opt.min || v > opt.max) { ctl.value = String(s[key]); toast(`${label}: ${opt.min} to ${opt.max}`, true); return; } set(v); });
    } else if (kind === 'range') {
      ctl = el('input', { id, type: 'range', min: String(opt.min), max: String(opt.max), step: String(opt.step || 1), value: String(s[key]) });
      val = el('span', { class: 'val' }, `${s[key]}${opt.unit || ''}`);
      ctl.addEventListener('input', () => { val.textContent = `${ctl.value}${opt.unit || ''}`; s[key] = Number(ctl.value); schedulePreview(); });
      ctl.addEventListener('change', () => set(Number(ctl.value)));
      ctl.addEventListener('dblclick', () => { ctl.value = String(R.STEPS[s.type].defaults[key]); val.textContent = `${ctl.value}${opt.unit || ''}`; set(Number(ctl.value)); });
    } else if (kind === 'colour') {
      ctl = el('input', { id, type: 'color', value: s[key] });
      ctl.addEventListener('input', () => { s[key] = ctl.value; schedulePreview(); });
      ctl.addEventListener('change', () => set(ctl.value));
    } else if (kind === 'text') {
      ctl = el('input', { id, type: 'text', value: s[key], maxlength: '200', spellcheck: 'false' });
      ctl.addEventListener('input', () => { s[key] = ctl.value; schedulePreview(400); });
      ctl.addEventListener('change', () => set(ctl.value));
    } else if (kind === 'check') {
      const box = el('input', { id, type: 'checkbox' }); box.checked = !!s[key];
      box.addEventListener('change', () => set(box.checked));
      return [el('label', { class: 'check full', 'data-key': key }, box, ' ' + label)];
    } else if (kind === 'file') {
      const name = el('span', { class: 'trunc small' }, s.file ? (S.logoNames[s.file] || s.file.split(/[\\/]/).pop()) : 'No logo chosen');
      const btn = el('button', { class: 'btn small', type: 'button', id }, 'Choose…');
      btn.addEventListener('click', async () => {
        try {
          const r = await pb.pickLogo();
          if (!r) return;
          S.logoNames[r.file] = r.name; store.set('logoNames', S.logoNames);
          s.file = r.file; name.textContent = r.name; changed();
        } catch (e) { toast(plain(e), true); }
      });
      return [el('span', { class: 'lab', 'data-key': key }, label), el('span', { class: 'ctl', 'data-key': key }, btn, name)];
    }
    return [el('label', { class: 'lab inline', for: id, 'data-key': key }, label), el('span', { class: 'ctl', 'data-key': key }, ctl, val, kind === 'number' && opt.unit ? el('span', { class: 'muted small' }, opt.unit) : null)];
  }
  function paintSteps() {
    const box = $('steps');
    box.replaceChildren(...S.recipe.map((s, i) => {
      const on = el('input', { type: 'checkbox', 'aria-label': `Use ${R.STEPS[s.type].label}` }); on.checked = s.on;
      on.addEventListener('change', () => { s.on = on.checked; changed(); });
      const up = el('button', { class: 'icon', type: 'button', title: 'Move up', 'aria-label': `Move ${R.STEPS[s.type].label} up` }, '▲'); up.disabled = i === 0;
      const down = el('button', { class: 'icon', type: 'button', title: 'Move down', 'aria-label': `Move ${R.STEPS[s.type].label} down` }, '▼'); down.disabled = i === S.recipe.length - 1;
      const rm = el('button', { class: 'icon', type: 'button', title: 'Remove this step', 'aria-label': `Remove ${R.STEPS[s.type].label}` }, '✕');
      up.addEventListener('click', () => moveStep(i, -1)); down.addEventListener('click', () => moveStep(i, 1));
      rm.addEventListener('click', () => { S.recipe.splice(i, 1); changed(true); });
      const body = el('div', { class: 'sb' });
      for (const f of FIELDS[s.type]) body.append(...control(s, f));
      return el('div', { class: 'step', 'data-id': String(s._id), 'data-type': s.type },
        el('div', { class: 'sh' }, el('span', { class: 'num' }, String(i + 1)), el('label', { class: 'check' }, on, ' ' + R.STEPS[s.type].label), up, down, rm), body);
    }));
    if (!S.recipe.length) box.append(el('p', { class: 'muted small' }, 'No steps yet: add one below. With no steps, photos are only converted and renamed.'));
    paintShowIf();
  }
  function moveStep(i, d) {
    const j = i + d; if (j < 0 || j >= S.recipe.length) return;
    [S.recipe[i], S.recipe[j]] = [S.recipe[j], S.recipe[i]];
    changed(true);
    const btn = document.querySelector(`.step[data-id="${S.recipe[j]._id}"] .icon[title="${d < 0 ? 'Move up' : 'Move down'}"]`);
    if (btn && !btn.disabled) btn.focus();
  }

  // ---- output settings ---------------------------------------------------------------------------------------------------------------
  function paintOutput() {
    const o = S.output;
    $('format').value = o.format; $('quality').value = String(o.quality); $('qVal').textContent = String(o.quality);
    $('metadata').value = o.metadata; $('pattern').value = o.pattern; $('autoOrient').checked = o.autoOrient;
    $('outDir').textContent = o.folder || 'Next to each photo, in edited/';
    $('outDir').title = o.folder || '';
    $('resetOut').hidden = !o.folder;
    $('quality').disabled = o.format === 'png';
    paintPatternExample();
  }
  function paintPatternExample() {
    const r = S.byId.get(S.current) || S.rows[0];
    const name = r ? r.name.replace(/\.[^.]+$/, '') : 'IMG_0412';
    const size = r && r.width ? R.predictSize(r.width, r.height, R.cleanRecipe(recipeOut())) : { width: 2048, height: 1365 };
    const ext = R.EXT[S.output.format === 'keep' ? ({ jpeg: 'jpeg', png: 'png', webp: 'webp', heif: 'avif', avif: 'avif' }[r && r.format] || 'jpeg') : S.output.format];
    $('patEx').textContent = `${R.expandPattern(S.output.pattern, { name, n: 1, date: new Date(), width: size.width, height: size.height })}.${ext}`;
  }
  function outChanged() { S.output = R.cleanOutput(S.output); saveState(); paintOutput(); schedulePreview(); }
  $('format').addEventListener('change', () => { S.output.format = $('format').value; outChanged(); });
  $('quality').addEventListener('input', () => { $('qVal').textContent = $('quality').value; });
  $('quality').addEventListener('change', () => { S.output.quality = Number($('quality').value); outChanged(); });
  $('metadata').addEventListener('change', () => { S.output.metadata = $('metadata').value; outChanged(); });
  $('pattern').addEventListener('input', () => { S.output.pattern = $('pattern').value; paintPatternExample(); });
  $('pattern').addEventListener('change', () => { S.output.pattern = $('pattern').value; outChanged(); });
  $('autoOrient').addEventListener('change', () => { S.output.autoOrient = $('autoOrient').checked; outChanged(); });
  $('pickOut').addEventListener('click', async () => { const d = await pb.pickOut(); if (d) { S.output.folder = d; outChanged(); } });
  $('resetOut').addEventListener('click', () => { S.output.folder = ''; outChanged(); });

  // ---- running --------------------------------------------------------------------------------------------------------------------
  function paintStart() {
    const n = S.rows.filter((r) => !r.problem).length;
    $('start').disabled = !n || S.running;
    $('start').textContent = n ? `Edit ${n} photo${n > 1 ? 's' : ''}` : 'Edit photos';
  }
  let runTotal = 0; let runDone = 0; let lastOut = '';
  async function start() {
    const ids = S.rows.filter((r) => !r.problem).map((r) => r.id);
    if (!ids.length || S.running) return;
    const logoStep = S.recipe.find((s) => s.on && s.type === 'logo' && !s.file);
    if (logoStep) { toast('Choose a logo for the logo watermark, or switch that step off', true); return; }
    S.running = true; runTotal = ids.length; runDone = 0; lastOut = '';
    for (const r of S.rows) { if (!r.problem) { r.status = ''; r.error = ''; r.out = ''; paintRow(r); } }
    $('cancel').hidden = false; $('runbar').hidden = false; $('reveal').hidden = true;
    $('fill').style.width = '0%'; $('runText').className = 'small'; $('runText').textContent = `Editing 0 of ${runTotal}…`;
    paintList(); lockUi(true);
    try {
      const res = await pb.start(ids, recipeOut(), S.output);
      const bits = [`${res.done} photo${res.done === 1 ? '' : 's'} saved in ${res.seconds.toFixed(1)} s`];
      if (res.failed) bits.push(`${res.failed} failed`);
      if (res.cancelled) bits.push(`${res.cancelled} skipped (cancelled)`);
      $('runText').textContent = bits.join(' · ') + (res.folders.length === 1 ? ` → ${res.folders[0]}` : res.folders.length > 1 ? ` → ${res.folders.length} "edited" folders` : '');
      $('runText').className = 'small ' + (res.failed ? 'err' : res.cancelled ? '' : 'ok');
      lastOut = res.firstOutput; $('reveal').hidden = !lastOut;
      $('fill').style.width = '100%';
    } catch (e) { $('runText').textContent = plain(e); $('runText').className = 'small err'; }
    finally { S.running = false; $('cancel').hidden = true; lockUi(false); paintList(); }
  }
  function lockUi(on) {
    for (const id of ['addFiles', 'addFolder', 'addFiles2', 'addFolder2', 'pickOut', 'format', 'metadata', 'pattern']) $(id).disabled = on;
  }
  pb.onItem((e) => {
    const r = S.byId.get(e.id); if (!r) return;
    r.status = e.status; r.error = e.error || ''; r.out = e.out || ''; r.outName = e.outName || '';
    paintRow(r);
    if (e.status !== 'working') {
      runDone++;
      const pct = Math.round((runDone / Math.max(1, runTotal)) * 100);
      $('fill').style.width = pct + '%'; $('prog').setAttribute('aria-valuenow', String(pct));
      $('runText').textContent = `Editing ${runDone} of ${runTotal}…`;
      if (e.out) lastOut = e.out;
    }
  });
  $('start').addEventListener('click', start);
  $('cancel').addEventListener('click', () => { pb.cancel(); $('runText').textContent = 'Stopping after the photos being edited right now…'; });
  $('reveal').addEventListener('click', () => { if (lastOut) pb.reveal(lastOut); });

  // ---- presets ------------------------------------------------------------------------------------------------------------------------
  function paintPresets(sel) {
    const names = Object.keys(S.presets).sort((a, b) => a.localeCompare(b));
    $('preset').replaceChildren(el('option', { value: '' }, names.length ? 'Choose…' : 'None saved yet'), ...names.map((n) => el('option', { value: n }, n)));
    $('preset').value = sel && S.presets[sel] ? sel : '';
    $('delPreset').hidden = !$('preset').value;
  }
  $('preset').addEventListener('change', () => {
    const p = S.presets[$('preset').value];
    $('delPreset').hidden = !p;
    if (!p) return;
    S.recipe = withIds(R.cleanRecipe(p.recipe)); S.output = R.cleanOutput(p.output);
    saveState(); paintSteps(); paintOutput(); schedulePreview(0);
    toast(`Preset "${$('preset').value}" loaded`);
  });
  $('savePreset').addEventListener('click', () => { $('presetForm').hidden = false; $('presetName').value = $('preset').value || ''; $('presetName').focus(); $('presetName').select(); });
  $('presetCancel').addEventListener('click', () => { $('presetForm').hidden = true; });
  $('presetName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('presetForm').requestSubmit(); }
    if (e.key === 'Escape') { e.preventDefault(); $('presetForm').hidden = true; }
  });
  $('presetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('presetName').value.trim();
    if (!name) { toast('Give the preset a name', true); return; }
    try {
      S.presets = await pb.savePreset(name, { recipe: recipeOut(), output: S.output });
      paintPresets(name); $('presetForm').hidden = true; toast(`Saved preset "${name}"`);
    } catch (err) { toast(plain(err), true); }
  });
  $('delPreset').addEventListener('click', async () => {
    const name = $('preset').value; if (!name) return;
    if (!window.confirm(`Delete the preset "${name}"?`)) return;
    S.presets = await pb.deletePreset(name); paintPresets(''); toast('Preset deleted');
  });

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  $('addFiles').addEventListener('click', () => addFrom(pb.pickFiles));
  $('addFiles2').addEventListener('click', () => addFrom(pb.pickFiles));
  $('addFolder').addEventListener('click', () => addFrom(pb.pickFolder));
  $('addFolder2').addEventListener('click', () => addFrom(pb.pickFolder));
  $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFrom(pb.pickFiles); } });
  $('clear').addEventListener('click', clearAll);
  $('removeSel').addEventListener('click', removeCurrent);
  $('modeSide').addEventListener('click', () => { setMode('side'); schedulePreview(0); });
  $('modeSlider').addEventListener('click', () => { setMode('slider'); schedulePreview(0); });
  $('sRange').addEventListener('input', syncSlider);
  $('sBefore').addEventListener('load', syncSlider);
  window.addEventListener('resize', syncSlider);
  $('addStep').replaceChildren(el('option', { value: '' }, '+ Add a step…'), ...Object.entries(R.STEPS).map(([k, v]) => el('option', { value: k }, v.label)));
  $('addStep').addEventListener('change', () => {
    const t = $('addStep').value; if (!t) return;
    S.recipe.push({ ...R.freshStep(t), _id: uid++ });
    $('addStep').value = '';
    changed(true);
    const card = document.querySelector(`.step[data-id="${S.recipe[S.recipe.length - 1]._id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.classList && e.target.classList.contains('item')) {
      e.preventDefault();
      const i = S.rows.findIndex((r) => r.id === S.current);
      const n = S.rows[Math.max(0, Math.min(S.rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) { select(n.id); n.btn.focus(); }
    } else if (e.key === 'Delete' && e.target.classList && e.target.classList.contains('item')) removeCurrent();
  });
  // drag and drop
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (S.running) return;
    const paths = [...(e.dataTransfer.files || [])].map((f) => { try { return pb.pathForFile(f); } catch { return ''; } }).filter(Boolean);
    if (paths.length) addFrom(() => pb.addPaths(paths));
  });
  pb.onOpened((r) => addRows(r));
  // draw the watermark words for the main process: cropped to the ink, with the soft shadow if asked
  pb.onTextDraw((r) => {
    try {
      const font = `${r.bold ? 700 : 400} ${r.ref}px "Segoe UI", "DejaVu Sans", "Noto Sans", Arial, sans-serif`;
      const c = document.createElement('canvas'); let g = c.getContext('2d');
      g.font = font;
      const m = g.measureText(r.text);
      const off = r.shadow ? Math.max(1, Math.round(r.ref / 22)) : 0;
      const l = Math.ceil(m.actualBoundingBoxLeft); const asc = Math.ceil(m.actualBoundingBoxAscent);
      c.width = Math.max(1, Math.min(16000, l + Math.ceil(m.actualBoundingBoxRight) + off + 2));
      c.height = Math.max(1, asc + Math.ceil(m.actualBoundingBoxDescent) + off + 2);
      g = c.getContext('2d'); g.font = font;
      if (r.shadow) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillText(r.text, l + 1 + off, asc + 1 + off); }
      g.fillStyle = r.colour; g.fillText(r.text, l + 1, asc + 1);
      pb.textTile(r.id, c.toDataURL('image/png'));
    } catch (e) { pb.textTile(r.id, null, String((e && e.message) || e)); }
  });

  async function init() {
    $('format').replaceChildren(...Object.entries(R.FORMATS).map(([k, v]) => el('option', { value: k }, v)));
    try { S.presets = await pb.presets(); } catch { S.presets = {}; }
    paintPresets('');
    paintSteps(); paintOutput(); paintList(); setMode(S.mode); clearPreview();
  }
  window.__app = { S, addRows, select, renderPreview, recipeOut, paintSteps, paintOutput, ready: false, previewsShown: () => pvShown };
  init().then(() => { window.__app.ready = true; }, (e) => { banner('The tool could not start: ' + plain(e)); window.__app.ready = true; });
})();
