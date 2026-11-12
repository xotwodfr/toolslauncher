'use strict';
// Export a note: a self-contained HTML page (pictures inlined, no outside links to load), and a Word document (.docx)
// built from the Markdown itself with the `docx` package. The PDF export prints the HTML page (see main.js).
const fs = require('fs');
const path = require('path');
const D = require('docx');
const R = require('./markdown');
const { esc } = require('./sanitize');

// ---- pictures ------------------------------------------------------------------------------------------------------------
/** Pixel size of a PNG, JPEG, GIF, BMP or WebP picture from its header (null when unknown). */
function imageSize(buf) {
  const b = Buffer.from(buf);
  try {
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* truncated */ }
  return null;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };

// ---- HTML ----------------------------------------------------------------------------------------------------------------
const EXPORT_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1d1d21; font: 16px/1.6 "Segoe UI", system-ui, -apple-system, "Noto Sans", Arial, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 48px 32px 80px; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 0.6em; } h1 { font-size: 2em; margin-top: 0; } h2 { font-size: 1.5em; border-bottom: 1px solid #e3e3e8; padding-bottom: .2em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: #2457c5; } img { max-width: 100%; height: auto; }
code { font: 0.9em ui-monospace, "Cascadia Mono", Consolas, "Liberation Mono", monospace; background: #f2f2f5; padding: .1em .3em; }
pre { background: #f6f8fa; padding: 12px 14px; overflow: auto; border: 1px solid #e3e3e8; } pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d0d0d8; margin-left: 0; padding: 0 1em; color: #55555f; }
table { border-collapse: collapse; } th, td { border: 1px solid #d0d0d8; padding: 6px 10px; } th { background: #f2f2f5; }
ul.tasks { list-style: none; padding-left: 1.2em; } li.task-item input { margin: 0 .5em 0 -1.2em; }
.tag { color: #6b4bb8; } .wikilink { color: #2457c5; text-decoration: none; border-bottom: 1px dotted; } .wikilink.missing { color: #a33; }
.frontmatter { font-size: .85em; color: #55555f; } .frontmatter th { text-align: left; font-weight: 600; }
.blocked-img { color: #888; font-style: italic; }
hr { border: 0; border-top: 1px solid #d0d0d8; margin: 2em 0; }
.footnotes { font-size: .9em; color: #55555f; }
@media print {
  main { max-width: none; padding: 0; }
  pre, blockquote, table, img { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
  a { color: inherit; }
}
@page { margin: 18mm 16mm; }
`;

let hljsCss = null;
function highlightCss() {
  if (hljsCss == null) { try { hljsCss = fs.readFileSync(require.resolve('highlight.js/styles/github.css'), 'utf8'); } catch { hljsCss = ''; } }
  return hljsCss;
}

/**
 * A complete, self-contained HTML page for the note: no scripts, every picture inlined as data, links that need the
 * notes app ([[wiki]] links and #tags) turned into plain styled text.
 *   readImage(src) -> { data: Buffer, ext } for a relative picture, or null
 */
function noteToHtml(text, { title = 'Note', readImage = () => null, resolveWiki } = {}) {
  let body = R.render(text, {
    resolveWiki,
    mapImage: (src) => { const img = readImage(src); return img && MIME[img.ext] ? `data:${MIME[img.ext]};base64,${Buffer.from(img.data).toString('base64')}` : null; },
  });
  // in a standalone file the in-app links mean nothing: keep their text, drop the link
  body = body.replace(/<a href="#" class="(wikilink[^"]*|tag)"[^>]*>([\s\S]*?)<\/a>/g, '<span class="$1">$2</span>');
  body = body.replace(/<input type="checkbox" class="task"/g, '<input type="checkbox" class="task" disabled');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="generator" content="Markdown Notes">
<title>${esc(title)}</title>
<style>${EXPORT_CSS}
${highlightCss()}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

// ---- DOCX ----------------------------------------------------------------------------------------------------------------
const HEADINGS = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6];
const MONO = 'Consolas';
const DOCX_IMAGE = { png: 'png', jpg: 'jpg', gif: 'gif', bmp: 'bmp' };

/** Inline tokens -> docx runs (TextRun / ExternalHyperlink / ImageRun / footnote references). */
function inlineRuns(children, ctx, base = {}) {
  const runs = [];
  const st = { bold: !!base.bold, italics: !!base.italics, strike: false, link: null, linkRuns: null };
  const push = (run) => { if (st.linkRuns) st.linkRuns.push(run); else runs.push(run); };
  const text = (t, extra = {}) => { if (t) push(new D.TextRun({ text: t, bold: st.bold || undefined, italics: st.italics || undefined, strike: st.strike || undefined, ...(st.link ? { style: 'Hyperlink' } : {}), ...base.run, ...extra })); };
  for (const c of children || []) {
    switch (c.type) {
      case 'text': text(c.content); break;
      case 'softbreak': text(' '); break;
      case 'hardbreak': push(new D.TextRun({ text: '', break: 1 })); break;
      case 'strong_open': st.bold = true; break;
      case 'strong_close': st.bold = !!base.bold; break;
      case 'em_open': st.italics = true; break;
      case 'em_close': st.italics = !!base.italics; break;
      case 's_open': st.strike = true; break;
      case 's_close': st.strike = false; break;
      case 'code_inline': text(c.content, { font: MONO, shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F2F2F5' } }); break;
      case 'link_open': {
        const href = c.attrGet('href') || '';
        if (/^(https?|mailto):/i.test(href)) { st.link = href; st.linkRuns = []; }
        break;
      }
      case 'link_close':
        if (st.linkRuns) { const kids = st.linkRuns; st.linkRuns = null; runs.push(new D.ExternalHyperlink({ link: st.link, children: kids.length ? kids : [new D.TextRun({ text: st.link, style: 'Hyperlink' })] })); st.link = null; }
        break;
      case 'image': {
        const src = c.attrGet('src') || '';
        const alt = c.content || (c.children || []).map((x) => x.content).join('');
        const img = /^[a-z][a-z0-9+.-]*:/i.test(src) ? null : ctx.readImage(src);
        const size = img && imageSize(img.data);
        if (img && DOCX_IMAGE[img.ext] && size && size.w && size.h) {
          const scale = Math.min(1, 600 / size.w, 800 / size.h);
          push(new D.ImageRun({ type: DOCX_IMAGE[img.ext], data: Buffer.from(img.data), transformation: { width: Math.round(size.w * scale), height: Math.round(size.h * scale) }, altText: { name: alt || 'picture', description: alt || '', title: alt || '' } }));
          ctx.stats.images++;
        } else text(`[${alt || 'picture'}]`, { italics: true, color: '888888' });
        break;
      }
      case 'html_inline':
        if (/^<br\s*\/?>$/i.test(c.content)) push(new D.TextRun({ text: '', break: 1 }));
        else if (c.meta && c.meta.task) text(c.meta.checked ? '☑ ' : '☐ ');
        break;
      case 'wikilink': text(c.meta.label || c.meta.target || c.meta.heading, { color: '2457C5' }); break;
      case 'hashtag': text('#' + c.meta.tag, { color: '6B4BB8' }); break;
      case 'footnote_ref': {
        const id = c.meta.id + 1;
        ctx.usedFootnotes.add(id);
        push(new D.FootnoteReferenceRun(id));
        break;
      }
      default: if (c.content) text(c.content);
    }
  }
  return runs;
}

/** Block tokens -> docx paragraphs and tables. Returns [children, nextIndex]. */
function blocks(tokens, i, end, ctx, list) {
  const out = [];
  while (i < end) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const level = Number(t.tag.slice(1)) - 1;
      out.push(new D.Paragraph({ heading: HEADINGS[level], children: inlineRuns(tokens[i + 1].children, ctx) }));
      ctx.stats.headings.push(tokens[i + 1].content);
      i += 3; continue;
    }
    if (t.type === 'paragraph_open') {
      const inline = tokens[i + 1];
      const opts = { children: inlineRuns(inline.children, ctx, ctx.base) };
      if (list && !list.used) {
        list.used = true;
        if (list.ordered) opts.numbering = { reference: 'numbers', level: Math.min(list.depth, 8), instance: list.instance };
        else if (list.task) opts.indent = { left: 360 * (list.depth + 1) };
        else opts.numbering = { reference: 'bullets', level: Math.min(list.depth, 8) };
      } else if (list) opts.indent = { left: 360 * (list.depth + 1) + 360 };
      if (ctx.quote) { opts.indent = { left: 567 * ctx.quote }; opts.border = { left: { style: D.BorderStyle.SINGLE, size: 12, color: 'C8C8D0', space: 8 } }; }
      out.push(new D.Paragraph(opts));
      i += 3; continue;
    }
    if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const close = matching(tokens, i);
      const ordered = t.type === 'ordered_list_open';
      const instance = ordered ? ++ctx.listInstance : 0;
      const depth = list ? list.depth + 1 : 0;
      let j = i + 1;
      while (j < close) {
        if (tokens[j].type === 'list_item_open') {
          const itemClose = matching(tokens, j);
          const item = { ordered, depth, instance, used: false, task: !!(tokens[j].meta && tokens[j].meta.task) };
          out.push(...blocks(tokens, j + 1, itemClose, ctx, item)[0]);
          j = itemClose + 1;
        } else j++;
      }
      i = close + 1; continue;
    }
    if (t.type === 'blockquote_open') {
      const close = matching(tokens, i);
      ctx.quote++;
      out.push(...blocks(tokens, i + 1, close, ctx, null)[0]);
      ctx.quote--;
      i = close + 1; continue;
    }
    if (t.type === 'fence' || t.type === 'code_block') {
      const lines = t.content.replace(/\n$/, '').split('\n');
      const runs = [];
      lines.forEach((l, k) => runs.push(new D.TextRun({ text: l, font: MONO, size: 19, break: k ? 1 : undefined })));
      out.push(new D.Paragraph({ children: runs, shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F6F8FA' }, border: { left: { style: D.BorderStyle.SINGLE, size: 6, color: 'D0D0D8', space: 6 } }, spacing: { before: 80, after: 160 } }));
      i++; continue;
    }
    if (t.type === 'hr') { out.push(new D.Paragraph({ thematicBreak: true, children: [] })); i++; continue; }
    if (t.type === 'table_open') {
      const close = matching(tokens, i);
      const rows = [];
      let row = null; let header = false;
      for (let j = i + 1; j < close; j++) {
        const x = tokens[j];
        if (x.type === 'thead_open') header = true;
        if (x.type === 'tbody_open') header = false;
        if (x.type === 'tr_open') row = [];
        if (x.type === 'th_open' || x.type === 'td_open') {
          const style = x.attrGet('style') || '';
          const align = /right/.test(style) ? D.AlignmentType.RIGHT : /center/.test(style) ? D.AlignmentType.CENTER : D.AlignmentType.LEFT;
          row.push(new D.TableCell({
            children: [new D.Paragraph({ alignment: align, children: inlineRuns(tokens[j + 1].children, ctx, { bold: header }) })],
            shading: header ? { type: D.ShadingType.CLEAR, color: 'auto', fill: 'F2F2F5' } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          }));
        }
        if (x.type === 'tr_close') { rows.push(new D.TableRow({ children: row, tableHeader: header || undefined })); row = null; }
      }
      if (rows.length) { out.push(new D.Table({ rows, width: { size: 100, type: D.WidthType.PERCENTAGE } })); out.push(new D.Paragraph({ children: [] })); ctx.stats.tables++; }
      i = close + 1; continue;
    }
    if (t.type === 'html_block') {
      const plain = t.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain) out.push(new D.Paragraph({ children: [new D.TextRun({ text: plain })] }));
      i++; continue;
    }
    if (t.type === 'footnote_block_open') {
      const close = matching(tokens, i);
      for (let j = i + 1; j < close; j++) {
        if (tokens[j].type === 'footnote_open') {
          const fClose = matching(tokens, j);
          const id = tokens[j].meta.id + 1;
          const kids = blocks(tokens, j + 1, fClose, ctx, null)[0];
          ctx.footnotes[id] = { children: kids.length ? kids : [new D.Paragraph({ children: [] })] };
          j = fClose;
        }
      }
      i = close + 1; continue;
    }
    if (t.type === 'footnote_anchor') { i++; continue; }
    i++;
  }
  return [out, i];
}

function matching(tokens, i) {
  const open = tokens[i];
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j].type === open.type) depth++;
    else if (tokens[j].type === open.type.replace(/_open$/, '_close')) { depth--; if (!depth) return j; }
  }
  return tokens.length - 1;
}

/**
 * The note as a Word document. Returns { buffer, stats: { headings, images, tables } }.
 *   readImage(src) -> { data, ext } | null (relative pictures only; nothing is fetched from the internet)
 */
async function noteToDocx(text, { title = 'Note', readImage = () => null } = {}) {
  const { tokens } = R.parse(text);
  // the footnote anchors (↩) are links back into the page; not wanted in Word
  for (const t of tokens) if (t.children) t.children = t.children.filter((c) => c.type !== 'footnote_anchor');
  const ctx = { readImage, stats: { headings: [], images: 0, tables: 0 }, listInstance: 0, quote: 0, footnotes: {}, usedFootnotes: new Set(), base: {} };
  const [children] = blocks(tokens, 0, tokens.length, ctx, null);
  const bulletLevels = []; const numberLevels = [];
  const bullets = ['•', '◦', '▪'];
  for (let l = 0; l < 9; l++) {
    bulletLevels.push({ level: l, format: D.LevelFormat.BULLET, text: bullets[l % 3], alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (l + 1), hanging: 260 } } } });
    numberLevels.push({ level: l, format: [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN][l % 3], text: `%${l + 1}.`, alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (l + 1), hanging: 300 } } } });
  }
  const footnotes = {};
  for (const id of ctx.usedFootnotes) if (ctx.footnotes[id]) footnotes[id] = ctx.footnotes[id];
  const doc = new D.Document({
    title, creator: 'Markdown Notes', description: '',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'bullets', levels: bulletLevels }, { reference: 'numbers', levels: numberLevels }] },
    footnotes,
    sections: [{ children: children.length ? children : [new D.Paragraph({ children: [] })] }],
  });
  return { buffer: await D.Packer.toBuffer(doc), stats: ctx.stats };
}

/** readImage for a note on disk: a relative src, decoded, must stay inside `root`. */
function imageReader(root, noteAbs) {
  const realRoot = path.resolve(root);
  return (src) => {
    let rel;
    try { rel = decodeURIComponent(String(src).split(/[?#]/)[0]); } catch { rel = String(src); }
    const abs = path.resolve(path.dirname(noteAbs), rel);
    if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) return null;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 40 * 1024 * 1024) return null;
      const data = fs.readFileSync(abs);
      const ext = require('./meta').sniffImage(data);
      return ext ? { data, ext } : null;
    } catch { return null; }
  };
}

module.exports = { noteToHtml, noteToDocx, imageSize, imageReader, EXPORT_CSS };
