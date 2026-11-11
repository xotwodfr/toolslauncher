'use strict';
// What goes inside a QR code: building the text for each kind (Wi-Fi, contact, event...) with the right escaping, and
// reading decoded text back into fields. Shared by the window (live preview) and main / the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Payload = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // ---- escaping -----------------------------------------------------------------------------------------------------------
  /** Wi-Fi and MeCard fields: backslash before \ ; , : " */
  const escMe = (s) => String(s == null ? '' : s).replace(/([\\;,:"])/g, '\\$1');
  /** vCard 3.0 / iCalendar text values: \\ \; \, and newlines as \n */
  const escV = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  const unescV = (s) => String(s).replace(/\\([\\;,nN:])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
  const unescMe = (s) => String(s).replace(/\\(.)/g, '$1');
  /** split on a separator that is not escaped with a backslash */
  function splitUnescaped(s, sep) {
    const out = []; let cur = ''; let esc = false;
    for (const ch of String(s)) {
      if (esc) { cur += '\\' + ch; esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === sep) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (esc) cur += '\\';
    out.push(cur);
    return out;
  }
  const clean = (s) => String(s == null ? '' : s).trim();
  const pad = (n) => String(n).padStart(2, '0');

  // ---- building -------------------------------------------------------------------------------------------------------------
  /** "2026-11-10T09:30" (a datetime-local value) -> 20261110T093000 ; "2026-11-10" -> 20261110 */
  function icsDate(v, allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(v || ''));
    if (!m) return null;
    return allDay ? `${m[1]}${m[2]}${m[3]}` : `${m[1]}${m[2]}${m[3]}T${m[4] || '00'}${m[5] || '00'}00`;
  }

  /**
   * @param {string} kind  text | url | wifi | vcard | mecard | email | sms | phone | geo | event
   * @param {object} f     the form fields
   * @returns {{ ok: boolean, text?: string, error?: string, warn?: string }}
   */
  function build(kind, f = {}) {
    const fail = (error) => ({ ok: false, error });
    switch (kind) {
      case 'text': {
        const t = String(f.text == null ? '' : f.text);
        if (!t) return fail('Type the text the code should hold.');
        return { ok: true, text: t };
      }
      case 'url': {
        let u = clean(f.url);
        if (!u) return fail('Type a web address.');
        if (/\s/.test(u)) return fail('A web address cannot contain spaces.');
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
        return { ok: true, text: u, warn: /^http:/i.test(u) ? 'This link is not secure (http, not https).' : undefined };
      }
      case 'wifi': {
        const ssid = String(f.ssid == null ? '' : f.ssid);
        if (!ssid) return fail('Type the network name.');
        const sec = f.security === 'WEP' ? 'WEP' : f.security === 'nopass' ? 'nopass' : 'WPA';
        const pw = String(f.password == null ? '' : f.password);
        if (sec !== 'nopass' && !pw) return fail('Type the password (or choose "No password").');
        let t = `WIFI:T:${sec};S:${escMe(ssid)};`;
        if (sec !== 'nopass') t += `P:${escMe(pw)};`;
        if (f.hidden) t += 'H:true;';
        return { ok: true, text: t + ';', warn: sec === 'WPA' && pw.length < 8 ? 'WPA passwords have at least 8 characters; check it.' : undefined };
      }
      case 'vcard': {
        const first = clean(f.first); const last = clean(f.last);
        if (!first && !last && !clean(f.org)) return fail('Type at least a name or a company.');
        const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${escV(last)};${escV(first)};;;`, `FN:${escV([first, last].filter(Boolean).join(' ') || clean(f.org))}`];
        if (clean(f.org)) L.push(`ORG:${escV(clean(f.org))}`);
        if (clean(f.title)) L.push(`TITLE:${escV(clean(f.title))}`);
        if (clean(f.phone)) L.push(`TEL;TYPE=CELL:${escV(clean(f.phone))}`);
        if (clean(f.workPhone)) L.push(`TEL;TYPE=WORK:${escV(clean(f.workPhone))}`);
        if (clean(f.email)) L.push(`EMAIL;TYPE=INTERNET:${escV(clean(f.email))}`);
        if (clean(f.website)) L.push(`URL:${escV(clean(f.website))}`);
        if (clean(f.street) || clean(f.city) || clean(f.zip) || clean(f.country)) L.push(`ADR;TYPE=WORK:;;${escV(clean(f.street))};${escV(clean(f.city))};${escV(clean(f.region))};${escV(clean(f.zip))};${escV(clean(f.country))}`);
        if (clean(f.note)) L.push(`NOTE:${escV(String(f.note).trim())}`);
        L.push('END:VCARD');
        return { ok: true, text: L.join('\r\n') };
      }
      case 'mecard': {
        const first = clean(f.first); const last = clean(f.last);
        if (!first && !last) return fail('Type at least a name.');
        let t = `MECARD:N:${escMe(last)}${first ? ',' + escMe(first) : ''};`;
        if (clean(f.phone)) t += `TEL:${escMe(clean(f.phone))};`;
        if (clean(f.email)) t += `EMAIL:${escMe(clean(f.email))};`;
        if (clean(f.website)) t += `URL:${escMe(clean(f.website))};`;
        const adr = [clean(f.street), clean(f.city), clean(f.zip), clean(f.country)].filter(Boolean).join(', ');
        if (adr) t += `ADR:${escMe(adr)};`;
        if (clean(f.org)) t += `ORG:${escMe(clean(f.org))};`;
        if (clean(f.note)) t += `NOTE:${escMe(String(f.note).trim())};`;
        return { ok: true, text: t + ';' };
      }
      case 'email': {
        const to = clean(f.to);
        if (!to) return fail('Type the email address.');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail('That does not look like an email address.');
        const q = [];
        if (clean(f.subject)) q.push('subject=' + encodeURIComponent(clean(f.subject)));
        if (String(f.body || '').trim()) q.push('body=' + encodeURIComponent(String(f.body).trim()));
        return { ok: true, text: `mailto:${to}${q.length ? '?' + q.join('&') : ''}` };
      }
      case 'sms': {
        const n = clean(f.number).replace(/[\s()-]/g, '');
        if (!/^\+?\d{3,20}$/.test(n)) return fail('Type a phone number (digits, may start with +).');
        return { ok: true, text: `SMSTO:${n}:${String(f.message || '')}` };
      }
      case 'phone': {
        const n = clean(f.number).replace(/[\s()-]/g, '');
        if (!/^\+?\d{3,20}$/.test(n)) return fail('Type a phone number (digits, may start with +).');
        return { ok: true, text: `tel:${n}` };
      }
      case 'geo': {
        const lat = Number(String(f.lat).replace(',', '.')); const lng = Number(String(f.lng).replace(',', '.'));
        if (clean(f.lat) === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) return fail('Latitude is a number from -90 to 90.');
        if (clean(f.lng) === '' || !Number.isFinite(lng) || lng < -180 || lng > 180) return fail('Longitude is a number from -180 to 180.');
        const r = (x) => String(Math.round(x * 1e6) / 1e6);
        return { ok: true, text: `geo:${r(lat)},${r(lng)}${clean(f.label) ? '?q=' + encodeURIComponent(clean(f.label)) : ''}` };
      }
      case 'event': {
        const title = clean(f.title);
        if (!title) return fail('Type a title for the event.');
        const allDay = !!f.allDay;
        const start = icsDate(f.start, allDay);
        if (!start) return fail('Choose when the event starts.');
        let end = f.end ? icsDate(f.end, allDay) : null;
        if (f.end && !end) return fail('The end time is not a valid date.');
        if (end && end < start) return fail('The event ends before it starts.');
        const L = ['BEGIN:VEVENT', `SUMMARY:${escV(title)}`, allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`];
        if (end) L.push(allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`);
        if (clean(f.location)) L.push(`LOCATION:${escV(clean(f.location))}`);
        if (String(f.description || '').trim()) L.push(`DESCRIPTION:${escV(String(f.description).trim())}`);
        L.push('END:VEVENT');
        return { ok: true, text: L.join('\r\n') };
      }
      default: return fail('Unknown kind of code');
    }
  }

  // ---- parsing ------------------------------------------------------------------------------------------------------------
  /** "KEY:value;KEY:value;;" (Wi-Fi, MeCard, MATMSG) */
  function fieldsOf(body) {
    const out = {};
    for (const part of splitUnescaped(body, ';')) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      const k = part.slice(0, i).toUpperCase();
      const v = unescMe(part.slice(i + 1));
      if (!(k in out)) out[k] = v; else out[k] += '\n' + v;
    }
    return out;
  }
  function fmtIcs(v) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(v || '').trim());
    if (!m) return String(v || '');
    return `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}${m[7] ? ' UTC' : ''}` : ''}`;
  }
  /** vCard / iCalendar lines: unfolded, each { name, params, value } */
  function contentLines(text) {
    const raw = String(text).replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const out = [];
    for (const line of raw) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const [name, ...params] = line.slice(0, i).split(';');
      out.push({ name: name.toUpperCase().replace(/^ITEM\d+\./, ''), params: params.join(';').toUpperCase(), value: line.slice(i + 1) });
    }
    return out;
  }

  /**
   * What a decoded code holds, in words.
   * @returns {{ kind: string, title: string, fields: {label:string, value:string, copy?:boolean, secret?:boolean}[], url?: string }}
   */
  function parse(text, format) {
    const t = String(text == null ? '' : text);
    const F = (label, value, extra) => (value == null || value === '' ? null : { label, value: String(value), copy: true, ...extra });
    const done = (kind, title, fields, extra) => ({ kind, title, fields: fields.filter(Boolean), ...extra });
    if (format && format !== 'qr') {
      if (['ean13', 'ean8', 'upca'].includes(format) || /^(EAN|UPC)/i.test(format)) {
        const digits = t.replace(/\D/g, '');
        let sum = 0; for (let i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
        const ok = String((10 - (sum % 10)) % 10) === digits.slice(-1);
        return done('product', 'Product number', [F('Number', digits), { label: 'Check digit', value: ok ? 'correct' : 'wrong (this number may be misread)' }]);
      }
      return done('text', 'Text', [F('Text', t)]);
    }
    const head = t.slice(0, 12).toUpperCase();
    if (head.startsWith('WIFI:')) {
      const f = fieldsOf(t.slice(5));
      const sec = (f.T || '').toUpperCase();
      return done('wifi', 'Wi-Fi network', [F('Network', f.S), F('Password', f.P, { secret: true }), { label: 'Security', value: sec === 'NOPASS' || !sec ? (f.P ? 'WPA/WEP' : 'None (open network)') : sec }, f.H && /^true$/i.test(f.H) ? { label: 'Hidden', value: 'yes' } : null]);
    }
    if (head.startsWith('BEGIN:VCARD')) {
      const L = contentLines(t);
      const get = (n) => L.filter((l) => l.name === n);
      const fields = [];
      const fn = get('FN')[0];
      const n = get('N')[0];
      const name = fn ? unescV(fn.value) : n ? splitUnescaped(n.value, ';').map(unescV).slice(0, 2).reverse().filter(Boolean).join(' ') : '';
      fields.push(F('Name', name));
      for (const o of get('ORG')) fields.push(F('Company', splitUnescaped(o.value, ';').map(unescV).filter(Boolean).join(', ')));
      for (const o of get('TITLE')) fields.push(F('Job title', unescV(o.value)));
      for (const o of get('TEL')) fields.push(F(/WORK/.test(o.params) ? 'Work phone' : /HOME/.test(o.params) ? 'Home phone' : 'Phone', unescV(o.value)));
      for (const o of get('EMAIL')) fields.push(F('Email', unescV(o.value)));
      for (const o of get('URL')) fields.push(F('Website', unescV(o.value)));
      for (const o of get('ADR')) fields.push(F('Address', splitUnescaped(o.value, ';').map(unescV).filter(Boolean).join(', ')));
      for (const o of get('NOTE')) fields.push(F('Note', unescV(o.value)));
      return done('vcard', 'Contact (vCard)', fields);
    }
    if (head.startsWith('MECARD:')) {
      const f = fieldsOf(t.slice(7));
      const nm = (f.N || '').split(',');
      return done('mecard', 'Contact (MeCard)', [F('Name', nm.length > 1 ? `${nm[1]} ${nm[0]}`.trim() : nm[0]), F('Company', f.ORG), F('Phone', f.TEL), F('Email', f.EMAIL), F('Website', f.URL), F('Address', f.ADR), F('Note', f.NOTE)]);
    }
    if (head.startsWith('BEGIN:VEVENT') || head.startsWith('BEGIN:VCALEN')) {
      const L = contentLines(t);
      const get = (n) => { const l = L.find((x) => x.name === n); return l ? l.value : ''; };
      return done('event', 'Calendar event', [F('Title', unescV(get('SUMMARY'))), F('Starts', fmtIcs(get('DTSTART'))), F('Ends', fmtIcs(get('DTEND'))), F('Place', unescV(get('LOCATION'))), F('Details', unescV(get('DESCRIPTION')))]);
    }
    if (/^mailto:/i.test(t)) {
      const [addr, q = ''] = t.slice(7).split('?');
      const p = new URLSearchParams(q);
      return done('email', 'Email', [F('To', decodeURIComponent(addr)), F('Subject', p.get('subject')), F('Message', p.get('body'))]);
    }
    if (head.startsWith('MATMSG:')) {
      const f = fieldsOf(t.slice(7));
      return done('email', 'Email', [F('To', f.TO), F('Subject', f.SUB), F('Message', f.BODY)]);
    }
    if (/^(smsto|sms|mmsto):/i.test(t)) {
      const body = t.replace(/^[a-z]+:/i, '');
      const m = /^([^:?]*)(?:[:?](?:body=)?([\s\S]*))?$/i.exec(body);
      let msg = m[2] || '';
      if (/^sms:/i.test(t) && /body=/i.test(body)) try { msg = decodeURIComponent(msg); } catch { /* keep */ }
      return done('sms', 'Text message', [F('To', m[1]), F('Message', msg)]);
    }
    if (/^tel:/i.test(t)) return done('phone', 'Phone number', [F('Number', t.slice(4))]);
    if (/^geo:/i.test(t)) {
      const m = /^geo:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)(?:,[-\d.]+)?(?:\?q=(.*))?/i.exec(t);
      if (m) { let label = m[3] || ''; try { label = decodeURIComponent(label); } catch { /* keep */ } return done('geo', 'Location', [F('Latitude', m[1]), F('Longitude', m[2]), F('Label', label)]); }
    }
    if (/^https?:\/\/\S+$/i.test(t.trim())) {
      const url = t.trim();
      let host = ''; try { host = new URL(url).host; } catch { /* odd */ }
      return done('url', 'Web link', [F('Link', url), F('Website', host)], { url, insecure: /^http:/i.test(url) });
    }
    return done('text', 'Text', [F('Text', t)]);
  }

  return { build, parse, escMe, escV, unescV, unescMe, splitUnescaped, icsDate, pad };
});
