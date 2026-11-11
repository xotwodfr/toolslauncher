'use strict';
(() => {
  const api = window.books;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  const KIND_EXT = /\.(epub|txt|md|markdown|html?|xhtml)$/i;

  // ---- messages ----------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) { const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500); }
  function banner(text) { $('banner').textContent = text || ''; $('banner').hidden = !text; }
  function result(text, kind, file) {
    const r = $('result');
    r.replaceChildren(el('span', {}, text));
    if (file) r.append(el('button', { class: 'btn ghost small', onclick: () => api.reveal(file) }, 'Show in folder'));
    r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text;
  }
  const failed = (r) => { if (r && r.error) { toast(r.error, true); return true; } return false; };

  // ---- small saved preferences (localStorage is only a convenience here) --------------------------------------------------------
  const PREF_KEY = 'ebook.reader';
  const prefs = (() => { const d = { fs: 100, font: 'serif', lh: '1.55', theme: 'dark', layout: 'paged' }; try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return d; } })();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* fine */ } };

  // ---- tabs ------------------------------------------------------------------------------------------------------------------------
  let tab = 'library';
  function showTab(t) {
    tab = t;
    for (const b of document.querySelectorAll('.tabs [role=tab]')) b.setAttribute('aria-selected', b.dataset.tab === t ? 'true' : 'false');
    $('viewLibrary').hidden = t !== 'library'; $('viewConvert').hidden = t !== 'convert'; $('viewDetails').hidden = t !== 'details';
    $('openBook').hidden = t !== 'library';
    result(''); banner('');
    if (t === 'library') drawLibrary();
  }
  document.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---- library -----------------------------------------------------------------------------------------------------------------------
  async function drawLibrary() {
    const list = await api.library();
    if (failed(list)) return;
    $('libEmpty').hidden = list.length > 0; $('libGrid').hidden = !list.length;
    $('libGrid').replaceChildren(...list.map((b) => {
      const cover = el('div', { class: 'cover' }, b.cover ? el('img', { src: b.cover, alt: '' }) : el('span', { class: 'ph' }, b.title));
      const card = el('div', { class: 'card' + (b.exists ? '' : ' missing'), role: 'button', tabindex: '0', 'data-id': b.id, title: b.exists ? b.path : 'Not found: ' + b.path },
        cover, el('span', { class: 't' }, b.title), el('span', { class: 'a trunc' }, (b.authors || []).join(', ') || ' '),
        el('div', { class: 'bar' }, (() => { const i = el('i'); i.style.width = Math.round((b.progress || 0) * 100) + '%'; return i; })()),
        el('div', { class: 'meta' }, el('span', {}, b.kind || ''), el('span', {}, b.progress ? Math.round(b.progress * 100) + '%' : 'new')),
        el('button', { class: 'x', 'aria-label': `Remove ${b.title} from the library`, title: 'Remove from the library (the file stays)', onclick: async (e) => { e.stopPropagation(); await api.removeFromLibrary(b.id); drawLibrary(); } }, '×'));
      const go = () => { if (!b.exists) { toast('That book is not where it was: ' + b.path, true); return; } openBook(b.path); };
      card.addEventListener('click', go);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      return card;
    }));
  }
  async function pickAndOpen() { const [p] = await api.pick('read'); if (p) openBook(p); }
  $('openBook').addEventListener('click', pickAndOpen);
  $('openBook2').addEventListener('click', pickAndOpen);

  // ---- reader ------------------------------------------------------------------------------------------------------------------------
  const R = { book: null, chapter: 0, page: 0, pages: 1, loading: null, saveTimer: null, hits: [], query: '' };
  const frame = $('frame');
  const doc = () => frame.contentDocument;
  const fwin = () => frame.contentWindow;

  async function openBook(file) {
    banner('');
    const b = await api.open(file);
    if (failed(b)) return;
    if (R.book) api.close(R.book.key);
    R.book = b; R.hits = []; R.query = '';
    const sizes = b.chapters.map((c) => Math.max(1, c.size));
    R.total = sizes.reduce((a, c) => a + c, 0); R.before = sizes.map((_s, i) => sizes.slice(0, i).reduce((a, c) => a + c, 0)); R.sizes = sizes;
    $('rTitle').textContent = b.meta.title || baseName(file);
    $('rAuthor').textContent = b.meta.authors && b.meta.authors.length ? 'by ' + b.meta.authors.join(', ') : '';
    document.title = (b.meta.title || baseName(file)) + ' · Ebook Converter & Reader';
    $('topLib').hidden = true; $('topReader').hidden = false; $('viewLibrary').hidden = true; $('viewConvert').hidden = true; $('viewDetails').hidden = true;
    $('viewReader').hidden = false; $('readerBar').hidden = false; result('');
    drawToc();
    $('findInput').value = ''; $('findResults').replaceChildren(); $('findCount').textContent = '';
    if (b.warnings && b.warnings.length) toast(b.warnings[0]);
    const pos = b.position;
    await loadChapter(pos && pos.chapter < b.chapters.length ? pos.chapter : 0, { frac: pos ? pos.frac : 0 });
    frame.focus();
  }
  function closeBook() {
    if (R.book) api.close(R.book.key);
    R.book = null;
    frame.srcdoc = '';
    $('topLib').hidden = false; $('topReader').hidden = true; $('viewReader').hidden = true; $('readerBar').hidden = true; $('aaPop').hidden = true;
    document.title = 'Ebook Converter & Reader';
    showTab('library');
  }
  $('back').addEventListener('click', closeBook);

  function drawToc() {
    const mk = (list) => list.map((t) => el('li', {},
      el('button', { 'data-chapter': t.chapter == null ? '' : String(t.chapter), onclick: () => { if (t.chapter != null) loadChapter(t.chapter, { frag: t.frag }); } }, t.label),
      t.children && t.children.length ? el('ol', {}, ...mk(t.children)) : null));
    $('toc').replaceChildren(...mk(R.book.toc));
  }
  function markToc() {
    let best = null;
    for (const b of $('toc').querySelectorAll('button')) { b.classList.remove('on'); if (b.dataset.chapter === String(R.chapter) && !best) best = b; }
    if (best) best.classList.add('on');
  }

  function applySettings() {
    const d = doc(); if (!d || !d.documentElement) return;
    const h = d.documentElement;
    h.className = [prefs.theme, prefs.layout, prefs.font === 'serif' ? '' : prefs.font].filter(Boolean).join(' ');
    h.style.setProperty('--fs', prefs.fs + '%');
    h.style.setProperty('--lh', prefs.lh);
    const narrow = fwin().innerWidth < 700;
    h.style.setProperty('--side', narrow ? '28px' : 'max(56px, calc((100vw - 40rem) / 2))'); // lines of a comfortable length
    $('viewReader').classList.toggle('light', prefs.theme === 'light'); $('viewReader').classList.toggle('sepia', prefs.theme === 'sepia');
  }

  /** Load a chapter into the frame, then go to a fraction of it, its end, a fragment, or a search hit. */
  async function loadChapter(index, { frac = 0, end = false, frag = '', hit = null } = {}) {
    if (!R.book) return;
    const key = R.book.key;
    const r = await api.chapter(key, index);
    if (!R.book || R.book.key !== key) return;
    if (failed(r)) return;
    R.chapter = index;
    frame.style.visibility = 'hidden';
    await new Promise((resolve) => { frame.onload = () => resolve(); frame.srcdoc = r.html; });
    const d = doc();
    applySettings();
    // wait for pictures, so the page count is right
    await Promise.race([Promise.all([...d.images].map((i) => (i.complete ? null : i.decode().catch(() => null)))), new Promise((res) => setTimeout(res, 1500))]);
    d.addEventListener('keydown', onKey);
    d.addEventListener('click', onFrameClick);
    if (prefs.layout === 'scrolled') d.addEventListener('scroll', () => { savePositionSoon(); updateBar(); }, { passive: true });
    $('rChapter').textContent = r.title;
    measure();
    if (hit) showHit(hit);
    else if (frag) goFrag(frag);
    else if (end) goPage(R.pages - 1);
    else goFrac(frac);
    frame.style.visibility = '';
    markToc();
    savePositionSoon();
  }

  const pageWidth = () => fwin().innerWidth;
  /** How far the columns are moved left right now. */
  const shift = () => { const t = doc().body.style.transform; const m = /translateX\((-?[\d.]+)px\)/.exec(t || ''); return m ? -Number(m[1]) : 0; };
  function measure() {
    if (prefs.layout !== 'paged') { R.pages = 1; return; }
    // a marker at the very end of the chapter: the column it lands in is the last page
    const d = doc(); const se = d.scrollingElement;
    let end = d.getElementById('__end');
    if (!end) { end = d.createElement('span'); end.id = '__end'; (d.querySelector('article.chapter') || d.body).append(end); }
    void se;
    const left = end.getBoundingClientRect().left + shift();
    R.pages = Math.max(1, Math.floor(left / pageWidth()) + 1);
  }
  function goPage(n) {
    if (prefs.layout !== 'paged') return;
    R.page = Math.max(0, Math.min(R.pages - 1, n));
    // the columns are moved, not scrolled: a scroll range stops short of the last page's padding
    doc().body.style.transform = R.page ? `translateX(${-R.page * pageWidth()}px)` : '';
    updateBar(); savePositionSoon();
  }
  function frac() {
    const se = doc() && doc().scrollingElement; if (!se) return 0;
    if (prefs.layout === 'paged') return R.pages > 1 ? R.page / (R.pages - 1) : 0;
    const max = se.scrollHeight - fwin().innerHeight;
    return max > 0 ? Math.min(1, se.scrollTop / max) : 0;
  }
  function goFrac(f) {
    if (prefs.layout === 'paged') goPage(Math.round(f * (R.pages - 1)));
    else { const se = doc().scrollingElement; se.scrollTop = f * (se.scrollHeight - fwin().innerHeight); updateBar(); }
  }
  function showElement(target) {
    if (!target) return;
    if (prefs.layout === 'paged') { const left = target.getBoundingClientRect().left + shift(); goPage(Math.floor(left / pageWidth())); }
    else { target.scrollIntoView({ block: 'center' }); updateBar(); }
  }
  function goFrag(frag) { const d = doc(); showElement(d.getElementById(frag) || d.querySelector(`[name="${CSS.escape(frag)}"]`)); }
  function updateBar() {
    if (!R.book) return;
    const f = frac();
    const progress = (R.before[R.chapter] + f * R.sizes[R.chapter]) / R.total;
    $('rFill').style.width = (progress * 100).toFixed(1) + '%';
    $('rPct').textContent = Math.round(progress * 100) + '%';
    $('rPage').textContent = prefs.layout === 'paged' ? `Page ${R.page + 1} of ${R.pages} · chapter ${R.chapter + 1} of ${R.book.chapters.length}` : `Chapter ${R.chapter + 1} of ${R.book.chapters.length}`;
  }
  function savePositionSoon() {
    clearTimeout(R.saveTimer);
    const b = R.book; if (!b) return;
    R.saveTimer = setTimeout(() => {
      if (!R.book || R.book !== b) return;
      const f = frac();
      api.savePosition(b.id, { chapter: R.chapter, frac: f, progress: (R.before[R.chapter] + f * R.sizes[R.chapter]) / R.total });
    }, 400);
  }

  async function next() {
    if (!R.book) return;
    if (prefs.layout === 'paged' && R.page < R.pages - 1) { goPage(R.page + 1); return; }
    if (prefs.layout === 'scrolled') { const se = doc().scrollingElement; if (se.scrollTop + fwin().innerHeight < se.scrollHeight - 4) { se.scrollTop += fwin().innerHeight * 0.9; return; } }
    if (R.chapter < R.book.chapters.length - 1) await loadChapter(R.chapter + 1);
  }
  async function prev() {
    if (!R.book) return;
    if (prefs.layout === 'paged' && R.page > 0) { goPage(R.page - 1); return; }
    if (prefs.layout === 'scrolled') { const se = doc().scrollingElement; if (se.scrollTop > 2) { se.scrollTop -= fwin().innerHeight * 0.9; return; } }
    if (R.chapter > 0) await loadChapter(R.chapter - 1, { end: true });
  }
  $('next').addEventListener('click', () => next());
  $('prev').addEventListener('click', () => prev());

  function onKey(e) {
    if (!R.book || $('viewReader').hidden) return;
    if (e.target && e.target.closest && e.target.closest('input, select, textarea') && e.target.ownerDocument === document) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'f') { e.preventDefault(); openSide('find'); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { if (prefs.layout === 'scrolled' && k === 'ArrowRight') return; e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { if (prefs.layout === 'scrolled' && k === 'ArrowLeft') return; e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); goFrac(0); }
    else if (k === 'End') { e.preventDefault(); goFrac(1); }
    else if (k === 'Escape') { if (!$('aaPop').hidden) $('aaPop').hidden = true; else if (!$('side').hidden) closeSide(); else closeBook(); }
    else if (k === 't' || k === 'T') { e.preventDefault(); openSide($('side').hidden || $('tocPanel').hidden ? 'toc' : null); }
  }
  document.addEventListener('keydown', (e) => { if (!$('viewReader').hidden) onKey(e); });

  function onFrameClick(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) { api.openLink(href); toast('Opened the link in your web browser.'); return; }
    const m = /^chapter-(\d+)\.xhtml(?:#(.*))?$/.exec(href);
    if (!m) return;
    const idx = Number(m[1]) - 1; const frag = m[2] ? decodeURIComponent(m[2]) : '';
    if (idx === R.chapter) { if (frag) goFrag(frag); } else loadChapter(idx, { frag });
  }

  // contents and search panels
  function openSide(which) {
    if (!which) { closeSide(); return; }
    $('side').hidden = false;
    $('tocPanel').hidden = which !== 'toc'; $('findPanel').hidden = which !== 'find';
    $('tocBtn').setAttribute('aria-pressed', which === 'toc' ? 'true' : 'false'); $('findBtn').setAttribute('aria-pressed', which === 'find' ? 'true' : 'false');
    if (which === 'find') { $('findInput').focus(); $('findInput').select(); } else { const on = $('toc').querySelector('.on'); if (on) on.scrollIntoView({ block: 'center' }); }
    requestAnimationFrame(relayout);
  }
  function closeSide() { $('side').hidden = true; $('tocBtn').setAttribute('aria-pressed', 'false'); $('findBtn').setAttribute('aria-pressed', 'false'); requestAnimationFrame(relayout); frame.focus(); }
  $('tocBtn').addEventListener('click', () => openSide($('side').hidden || $('tocPanel').hidden ? 'toc' : null));
  $('findBtn').addEventListener('click', () => openSide($('side').hidden || $('findPanel').hidden ? 'find' : null));

  let findTimer = null; let findSeq = 0;
  $('findInput').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
  $('findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = $('findResults').querySelector('button'); if (b) b.click(); } if (e.key === 'Escape') { e.stopPropagation(); closeSide(); } });
  async function runFind() {
    const q = $('findInput').value.trim();
    R.query = q;
    if (q.length < 2) { $('findResults').replaceChildren(); $('findCount').textContent = q ? 'Type at least two letters.' : ''; clearHits(); return; }
    const seq = ++findSeq;
    const r = await api.search(R.book.key, q);
    if (seq !== findSeq || failed(r)) return;
    $('findCount').textContent = r.results.length ? `${r.capped ? '500+' : r.results.length} place${r.results.length === 1 ? '' : 's'}` : 'Not found in this book.';
    $('findResults').replaceChildren(...r.results.map((h) => el('li', {}, el('button', { onclick: () => goHit(h) }, el('span', { class: 'ct' }, h.title), h.before, el('mark', {}, h.match), h.after))));
    if (R.book) highlightAll(q);
  }
  async function goHit(h) {
    if (h.chapter !== R.chapter) await loadChapter(h.chapter, { hit: h });
    else showHit(h);
  }
  function clearHits() {
    const d = doc(); if (!d) return;
    for (const m of [...d.querySelectorAll('mark.hit')]) { const t = d.createTextNode(m.textContent); m.replaceWith(t); t.parentNode.normalize(); }
  }
  /** Mark every place the words appear in the page that is showing. */
  function highlightAll(q) {
    const d = doc(); if (!d || !d.body) return [];
    clearHits();
    const low = q.toLowerCase();
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    const marks = [];
    for (const t of nodes) {
      let s = t.data; let at; let cur = t;
      while ((at = s.toLowerCase().indexOf(low)) !== -1) {
        const hit = cur.splitText(at); const rest = hit.splitText(q.length);
        const m = d.createElement('mark'); m.className = 'hit'; hit.replaceWith(m); m.append(hit);
        marks.push(m); cur = rest; s = rest.data;
      }
    }
    measure();
    return marks;
  }
  function showHit(h) {
    const marks = highlightAll(R.query || h.match);
    const m = marks[Math.min(h.nth, marks.length - 1)];
    if (!m) return;
    for (const x of marks) x.classList.remove('current');
    m.classList.add('current');
    showElement(m);
  }

  // text and layout settings
  $('aaBtn').addEventListener('click', () => { $('aaPop').hidden = !$('aaPop').hidden; });
  document.addEventListener('mousedown', (e) => { if (!$('aaPop').hidden && !$('aaPop').contains(e.target) && e.target !== $('aaBtn')) $('aaPop').hidden = true; });
  function drawPrefs() {
    $('fsVal').textContent = prefs.fs + '%'; $('fontSel').value = prefs.font; $('lhSel').value = prefs.lh;
    document.querySelectorAll('[data-theme]').forEach((b) => b.setAttribute('aria-checked', b.dataset.theme === prefs.theme ? 'true' : 'false'));
    document.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-checked', b.dataset.layout === prefs.layout ? 'true' : 'false'));
  }
  /** After a setting changes: keep the same place in the chapter. */
  async function changed(reload = false) {
    savePrefs(); drawPrefs();
    if (!R.book) return;
    const f = frac();
    if (reload) { await loadChapter(R.chapter, { frac: f }); return; }
    applySettings(); measure(); goFrac(f);
  }
  $('fsDown').addEventListener('click', () => { prefs.fs = Math.max(70, prefs.fs - 10); changed(); });
  $('fsUp').addEventListener('click', () => { prefs.fs = Math.min(220, prefs.fs + 10); changed(); });
  $('fontSel').addEventListener('change', () => { prefs.font = $('fontSel').value; changed(); });
  $('lhSel').addEventListener('change', () => { prefs.lh = $('lhSel').value; changed(); });
  document.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => { prefs.theme = b.dataset.theme; changed(); }));
  document.querySelectorAll('[data-layout]').forEach((b) => b.addEventListener('click', () => { if (prefs.layout !== b.dataset.layout) { prefs.layout = b.dataset.layout; changed(true); } }));
  drawPrefs();
  function relayout() { if (!R.book || !doc()) return; const f = frac(); applySettings(); measure(); goFrac(f); }
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 120); });

  // ---- converter -----------------------------------------------------------------------------------------------------------------------
  const CV = { files: [], format: 'epub', outDir: null, running: false };
  const FORMAT_NOTES = {
    epub: 'An EPUB 3 book with a table of contents. Text files are split into chapters at lines like "Chapter 1".',
    pdf: 'A printable PDF: a title page, the contents, and each chapter starting on a new page.',
    html: 'One web page with everything in it, pictures included.',
    md: 'Markdown with the details at the top. Pictures go into a folder next to the .md file.',
    txt: 'Plain text, chapter by chapter. Pictures and formatting are left out.',
  };
  function addConvertFiles(paths) {
    let skipped = 0;
    for (const p of paths) {
      if (!KIND_EXT.test(p)) { skipped++; continue; }
      if (CV.files.some((f) => f.path === p)) continue;
      CV.files.push({ path: p, name: baseName(p), kind: (KIND_EXT.exec(p)[1] || '').toLowerCase().replace('markdown', 'md').replace(/^htm$|^xhtml$/, 'html'), status: '', note: '' });
    }
    if (skipped) toast(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped: only EPUB, TXT, Markdown and HTML can be converted.`, true);
    drawConvert();
  }
  function drawConvert() {
    const list = $('convList');
    if (!CV.files.length) list.replaceChildren(el('div', { class: 'emptyline' }, 'No files yet.'));
    else list.replaceChildren(...CV.files.map((f, i) => el('div', { class: 'item', 'data-index': String(i) },
      el('span', { class: 'kind' }, f.kind), el('span', { class: 'name trunc', title: f.path }, f.name),
      el('span', { class: 'st trunc ' + f.status, title: f.note }, f.note || ''),
      f.outputs && f.outputs[0] ? el('button', { class: 'btn ghost small', onclick: () => api.reveal(f.outputs[0]) }, 'Show in folder') : null,
      CV.running ? null : el('button', { class: 'rm', 'aria-label': 'Remove ' + f.name, onclick: () => { CV.files.splice(i, 1); drawConvert(); } }, '×'))));
    $('convGo').disabled = !CV.files.length || CV.running;
    $('convClear').hidden = !CV.files.length || CV.running;
    $('convCancel').hidden = !CV.running;
    document.querySelectorAll('[data-format]').forEach((b) => b.setAttribute('aria-checked', b.dataset.format === CV.format ? 'true' : 'false'));
    $('formatNote').textContent = FORMAT_NOTES[CV.format];
    $('pageSizeBox').hidden = CV.format !== 'pdf';
    $('outDirLabel').textContent = CV.outDir ? CV.outDir : 'Next to each original';
    $('outDirReset').hidden = !CV.outDir;
  }
  document.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => { if (!CV.running) { CV.format = b.dataset.format; drawConvert(); } }));
  $('convAdd').addEventListener('click', async () => addConvertFiles(await api.pick('convert')));
  $('convClear').addEventListener('click', () => { CV.files = []; result(''); drawConvert(); });
  $('outDirBtn').addEventListener('click', async () => { const d = await api.pickDir(); if (d && !d.error) { CV.outDir = d; drawConvert(); } });
  $('outDirReset').addEventListener('click', () => { CV.outDir = null; drawConvert(); });
  $('convCancel').addEventListener('click', () => { api.cancelConvert(); $('convStatus').textContent = 'Stopping after this file…'; });
  api.onConvertProgress((p) => {
    const f = CV.files[p.index]; if (!f) return;
    f.status = p.status;
    f.note = p.status === 'working' ? 'Converting…' : p.status === 'done' ? `Done: ${baseName(p.outputs[0])}` : p.status === 'error' ? p.error : p.status === 'cancelled' ? 'Not converted (cancelled)' : '';
    f.outputs = p.outputs;
    const done = CV.files.filter((x) => ['done', 'error', 'cancelled'].includes(x.status)).length;
    $('convFill').style.width = Math.round((done / CV.files.length) * 100) + '%';
    $('convStatus').textContent = `${done} of ${CV.files.length}`;
    drawConvert();
  });
  $('convGo').addEventListener('click', async () => {
    if (CV.running || !CV.files.length) return;
    CV.running = true; result('');
    CV.files.forEach((f) => { f.status = ''; f.note = 'Waiting'; f.outputs = null; });
    $('convProg').hidden = false; $('convFill').style.width = '0%'; $('convStatus').textContent = 'Starting…';
    drawConvert();
    const r = await api.convert(CV.files.map((f) => f.path), CV.format, { pageSize: $('pageSize').value, outDir: CV.outDir });
    CV.running = false; $('convProg').hidden = true; $('convStatus').textContent = '';
    drawConvert();
    if (failed(r)) return;
    const parts = [`Converted ${r.done} file${r.done === 1 ? '' : 's'}`];
    if (r.failed) parts.push(`${r.failed} could not be converted (see the list)`);
    if (r.cancelled) parts.push(`${r.cancelled} cancelled`);
    result(parts.join(', ') + '.', r.failed ? 'err' : 'ok', r.outputs.length === 1 ? r.outputs[0] : null);
  });
  drawConvert();

  // ---- details editor -------------------------------------------------------------------------------------------------------------------
  const D = { path: null, coverChanged: false };
  async function openDetails(file) {
    const r = await api.openDetails(file);
    if (failed(r)) return;
    D.path = r.path; D.coverChanged = false; result('');
    $('detEmpty').hidden = true; $('detForm').hidden = false;
    $('detFile').textContent = `${r.path}  ·  EPUB ${r.version}  ·  ${r.chapters} part${r.chapters === 1 ? '' : 's'}`;
    $('fTitle').value = r.meta.title || ''; $('fAuthors').value = (r.meta.authors || []).join('; '); $('fLang').value = r.meta.language || '';
    $('fPublisher').value = r.meta.publisher || ''; $('fDesc').value = r.meta.description || '';
    showCover(r.cover); $('coverNew').textContent = '';
    $('fTitle').focus();
  }
  function showCover(src) { $('coverImg').hidden = !src; if (src) $('coverImg').src = src; else $('coverImg').removeAttribute('src'); $('coverNone').hidden = !!src; }
  async function chooseDetails() { const [p] = await api.pick('details'); if (p) openDetails(p); }
  $('detOpen').addEventListener('click', chooseDetails);
  $('detOther').addEventListener('click', chooseDetails);
  async function setCover(droppedPath) {
    const r = await api.pickCover(droppedPath || null);
    if (!r || r.cancelled || failed(r)) return;
    D.coverChanged = true; showCover(r.preview); $('coverNew').textContent = 'New cover: ' + r.name;
  }
  $('coverPick').addEventListener('click', () => setCover());
  $('detForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!D.path) return;
    if (!$('fTitle').value.trim()) { toast('A book needs a title.', true); $('fTitle').focus(); return; }
    const r = await api.saveDetails(D.path, { title: $('fTitle').value, authors: $('fAuthors').value, language: $('fLang').value, publisher: $('fPublisher').value, description: $('fDesc').value, cover: D.coverChanged });
    if (!r || r.cancelled) return;
    if (r.error) { result('Not saved: ' + r.error, 'err'); return; }
    result(`Saved a new book: ${baseName(r.path)} (the original is unchanged).`, 'ok', r.path);
  });

  // ---- drag and drop -------------------------------------------------------------------------------------------------------------------
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const paths = [...(e.dataTransfer.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    if (!$('viewConvert').hidden) addConvertFiles(paths);
    else if (!$('viewDetails').hidden) {
      const img = paths.find((p) => /\.(jpe?g|png|gif|webp)$/i.test(p));
      const epub = paths.find((p) => /\.epub$/i.test(p));
      if (img && D.path) setCover(img); else if (epub) openDetails(epub); else toast('Drop an EPUB here, or a picture for the cover.', true);
    } else {
      const book = paths.find((p) => KIND_EXT.test(p));
      if (book) openBook(book); else toast('That is not a book this app opens (EPUB, TXT, Markdown or HTML).', true);
    }
  });
  api.onOpenFile((p) => openBook(p));

  drawLibrary();
  window.__app = { R, CV, D, prefs, openBook, closeBook, loadChapter, next, prev, showTab, openDetails, addConvertFiles, frac };
})();
