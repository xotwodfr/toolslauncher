'use strict';
// A strict allow-list HTML sanitiser for the rendered Markdown. The HTML is parsed with htmlparser2 and written out
// again from scratch: only the tags and attributes below survive, every text and attribute value is escaped again,
// the contents of script/style/iframe/... are dropped entirely, and links may only be http(s), mailto, in-page (#)
// or relative. The preview page also has a Content-Security-Policy without inline scripts, so even a sanitiser bug
// could not run a script there; this is the first wall, not the only one.
const { Parser } = require('htmlparser2');

const GLOBAL_ATTRS = ['class', 'id', 'title', 'lang', 'dir', 'align', 'data-line'];
const TAGS = {
  a: ['href', 'data-wiki', 'data-heading', 'data-tag', 'rel'], abbr: [], b: [], blockquote: ['cite'], br: [], caption: [], cite: [], code: [],
  col: ['span'], colgroup: ['span'], dd: [], del: [], details: ['open'], dfn: [], div: [], dl: [], dt: [], em: [], figcaption: [], figure: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: [], i: [], img: ['src', 'alt', 'width', 'height', 'data-src'], ins: [], kbd: [], li: ['value', 'data-line'],
  mark: [], ol: ['start', 'reversed', 'type'], p: [], pre: [], q: [], s: [], samp: [], section: [], small: [], span: [], strong: [], sub: [], summary: [], sup: [],
  table: [], tbody: [], td: ['colspan', 'rowspan', 'style'], tfoot: [], th: ['colspan', 'rowspan', 'scope', 'style'], thead: [], tr: [], u: [], ul: [], var: [],
  input: ['type', 'checked', 'disabled', 'data-line'], label: [],
};
// Elements whose whole content is thrown away (not just the tags).
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'select', 'button', 'svg', 'math', 'frameset', 'frame', 'noembed', 'xmp', 'plaintext', 'title', 'head', 'form', 'applet', 'audio', 'video', 'canvas', 'link', 'meta', 'base']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'col']);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Is this URL allowed in a link? (After entities were decoded by the parser.) */
function safeHref(v) {
  const s = String(v).replace(/[\x00-\x20\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return /^(https?|mailto):/i.test(s);
  return !/^\/\//.test(s); // protocol-relative URLs would reach the network
}
/** Image sources: our own notes protocol, inline data pictures (not SVG), or relative paths (mapped by the caller). */
function safeSrc(v, allowRelative) {
  const s = String(v).replace(/[\x00-\x20\x7f-\x9f]/g, '');
  if (/^notefile:\/\//i.test(s)) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=]+$/i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^\/\//.test(s)) return false;
  return !!allowRelative;
}
// Only text-align survives in style attributes (markdown-it writes it for table columns).
const safeStyle = (v) => { const m = /^\s*text-align\s*:\s*(left|right|center)\s*;?\s*$/i.exec(String(v)); return m ? `text-align:${m[1].toLowerCase()}` : null; };

/**
 * sanitize(html, { allowRelativeImages }) -> safe HTML.
 * Remote images (http/https) are replaced by their alt text in a <span class="blocked-img">, because the app is offline.
 */
function sanitize(html, opts = {}) {
  const out = [];
  const stack = [];    // open allowed tags, to close them properly
  let dropDepth = 0;   // > 0 while inside a DROP_CONTENT element
  const parser = new Parser({
    onopentag(name, attrs) {
      name = name.toLowerCase();
      if (dropDepth || DROP_CONTENT.has(name)) { if (!VOID.has(name)) dropDepth++; return; }
      const allowed = TAGS[name];
      if (!allowed) { stack.push(null); return; }
      if (name === 'img') {
        const original = String(attrs.src || '').trim();
        let src = original;
        // relative pictures are mapped by the caller (to the notes protocol, or to inline data for an export)
        if (src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^\/\//.test(src) && opts.mapImage) src = opts.mapImage(src) || '';
        attrs = { ...attrs, src };
        if (!src || !safeSrc(src, opts.allowRelativeImages)) {
          out.push(`<span class="blocked-img" title="${escAttr(/^(https?:)?\/\//i.test(original) ? 'Pictures from the internet are not loaded: ' + original.slice(0, 300) : 'Picture not found: ' + original.slice(0, 300))}">${esc(attrs.alt || 'picture')}</span>`);
          return;
        }
      }
      if (name === 'input' && String(attrs.type || '').toLowerCase() !== 'checkbox') return;
      let s = '<' + name;
      for (const [k0, v] of Object.entries(attrs)) {
        const k = k0.toLowerCase();
        if (!(GLOBAL_ATTRS.includes(k) || allowed.includes(k))) continue;
        if (k === 'href' && !safeHref(v)) continue;
        if (k === 'src' && !safeSrc(v, opts.allowRelativeImages)) continue;
        if (k === 'class' && name === 'input') { s += ' class="task"'; continue; }
        if (k === 'id' && !/^[\w:.\-\p{L}\p{N}]{1,200}$/u.test(v)) continue;
        if (k === 'style') { const st = safeStyle(v); if (st) s += ` style="${st}"`; continue; }
        if ((k === 'width' || k === 'height' || k === 'colspan' || k === 'rowspan' || k === 'start' || k === 'span' || k === 'value' || k === 'data-line') && !/^\d{1,6}$/.test(v)) continue;
        s += v === '' && (k === 'checked' || k === 'disabled' || k === 'open' || k === 'reversed') ? ` ${k}` : ` ${k}="${escAttr(v)}"`;
      }
      if (name === 'a' && /^https?:/i.test(attrs.href || '')) s += ' rel="noopener noreferrer"';
      out.push(s + '>');
      if (!VOID.has(name)) stack.push(name);
    },
    ontext(text) { if (!dropDepth) out.push(esc(text)); },
    onclosetag(name) {
      name = name.toLowerCase();
      if (dropDepth) { if (!VOID.has(name)) dropDepth--; return; }
      if (VOID.has(name)) return;
      // htmlparser2 balances the tags, so the element closing is always the one on top
      const top = stack.pop();
      if (top) out.push(`</${top}>`);
    },
    oncomment() { /* comments are dropped */ },
    onprocessinginstruction() { /* dropped */ },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  parser.write(String(html || ''));
  parser.end();
  for (let j = stack.length - 1; j >= 0; j--) if (stack[j]) out.push(`</${stack[j]}>`);
  return out.join('');
}

module.exports = { sanitize, safeHref, safeSrc, esc, escAttr };
