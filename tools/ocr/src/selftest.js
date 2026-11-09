'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Draws text into a picture inside the real window, reads it
// with the engine that ships in the package (WebAssembly OCR in a worker, with the bundled language files), then loads the
// same kind of picture through the window and reads it from there. Needs no network.
const { installedLanguages } = require('./ocr');
const Tidy = require('./tidy');
const { CODES } = require('./languages');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, engine }) {
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const win = getWin();
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Estimating resolution|willReadFrequently/.test(msg)) errors.push(msg); });
  const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
  /** A picture of text, drawn by the window: returns the PNG as base64. */
  const draw = (lines, color = '#000', bg = '#fff') => js(`(async()=>{
    const c=document.createElement('canvas'); c.width=1000; c.height=40+${lines.length}*64; const g=c.getContext('2d');
    g.fillStyle=${JSON.stringify(bg)}; g.fillRect(0,0,c.width,c.height); g.fillStyle=${JSON.stringify(color)}; g.font='40px "Segoe UI", Arial, sans-serif';
    ${JSON.stringify(lines)}.forEach((t,i)=>g.fillText(t,30,70+i*64));
    const b=await new Promise(r=>c.toBlob(r,'image/png')); const buf=new Uint8Array(await b.arrayBuffer()); let s=''; for(let i=0;i<buf.length;i+=8192) s+=String.fromCharCode.apply(null,buf.subarray(i,i+8192)); return btoa(s); })()`);

  await step('all language files are in the package', async () => {
    const have = installedLanguages();
    if (have.length !== CODES.length) throw new Error(`only ${have.length} of ${CODES.length} languages found`);
    return have.join(' ');
  });
  await step('reads text from a picture with the packaged engine', async () => {
    const png = Buffer.from(await draw(['Offline text reading works', 'on this computer, no internet needed']), 'base64');
    const r = await engine.recognize(png, { langs: 'eng' });
    const sim = Tidy.similarity(r.text, 'Offline text reading works\non this computer, no internet needed');
    if (sim < 0.93) throw new Error(`read ${JSON.stringify(r.text)} (${Math.round(sim * 100)}% right)`);
    return `${Math.round(sim * 100)}% right, ${r.words.length} words, ${r.ms} ms`;
  });
  await step('reads Swedish letters with the Swedish language file', async () => {
    const png = Buffer.from(await draw(['Smörgåsar och äppelpaj på söndagen']), 'base64');
    const r = await engine.recognize(png, { langs: 'swe' });
    const sim = Tidy.similarity(r.text, 'Smörgåsar och äppelpaj på söndagen');
    if (sim < 0.9) throw new Error(`read ${JSON.stringify(r.text)}`);
    return `${Math.round(sim * 100)}% right`;
  });
  await step('the window loads a picture, reads it and shows the text', async () => {
    await waitFor('!!window.__app');
    const b64 = await draw(['Light text on dark', 'is turned around first'], '#e8e8e8', '#1f1f1f');
    await js(`(async()=>{ const bin=atob(${JSON.stringify(b64)}); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); await window.__app.addItems([{ blob: new Blob([u], {type:'image/png'}), name: 'Self test' }]); })()`);
    await waitFor('window.__app.S.items.length === 1');
    await js('document.getElementById("read").click()');
    await waitFor('window.__app.S.items[0].status === "done" || window.__app.S.items[0].status === "error"');
    const status = await js('window.__app.S.items[0].status');
    if (status !== 'done') throw new Error('reading failed: ' + (await js('window.__app.S.items[0].error')));
    const text = await js('document.getElementById("text").value');
    const sim = Tidy.similarity(text, 'Light text on dark\nis turned around first');
    if (sim < 0.9) throw new Error(`read ${JSON.stringify(text)}`);
    if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
    return `${Math.round(sim * 100)}% right`;
  });
  return results;
}

module.exports = { run };
