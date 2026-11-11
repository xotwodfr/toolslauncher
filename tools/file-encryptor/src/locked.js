'use strict';
// The .locked format: a password-derived key and STREAMING chunked AES-256-GCM, so files of any size are encrypted and
// decrypted in constant memory, and truncation, reordering, dropping, duplicating or changing any chunk is detected.
// The construction is the "STREAM" online AEAD of Hoang, Reyhanitabar, Rogaway and Vizár (2015), as used by Tink's
// streaming AEAD and age: each 64 KiB chunk is sealed with nonce = prefix || counter and a last-chunk flag. See FORMAT.md.
// Primitives: Argon2id (hash-wasm), HKDF-SHA256 and AES-256-GCM (Node crypto). Nothing home-made.
const crypto = require('crypto');
const fs = require('fs');
const { argon2id } = require('hash-wasm');

const MAGIC = Buffer.from([0x46, 0x45, 0x4e, 0x43, 0x0d, 0x0a, 0x1a, 0x0a]); // "FENC\r\n\x1a\n"
const VERSION = 1;
const PREFIX = MAGIC.length + 2 + 4;
const MAX_HEADER = 4096;
const CHUNK = 64 * 1024;
const TAG = 16;
const SEG = CHUNK + TAG;
const NONCE_PREFIX = 8; // + 4-byte big-endian counter = the 12-byte GCM nonce
const MAX_META = 16 * 1024;
const KDF = { m: 64 * 1024, t: 3, p: 1 };
const LIMITS = { mMin: 8 * 1024, mMax: 1024 * 1024, tMin: 1, tMax: 40, pMin: 1, pMax: 8 };
const INFO = Buffer.from('file-encryptor/v1 payload key');

class LockedError extends Error { constructor(code, message) { super(message); this.code = code; } }
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true, code: 'cancelled' });

/** Password -> 32-byte master key (Argon2id). The password is NFC-normalised so it types the same everywhere. */
async function deriveMaster(password, salt, kdf = KDF) {
  if (typeof password !== 'string' || !password) throw new LockedError('password', 'Type the password.');
  checkKdf(kdf);
  const out = await argon2id({ password: Buffer.from(password.normalize('NFC'), 'utf8'), salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' });
  return Buffer.from(out);
}
function checkKdf(k) {
  const int = Number.isInteger;
  if (!k || !int(k.m) || !int(k.t) || !int(k.p) || k.m < LIMITS.mMin || k.m > LIMITS.mMax || k.t < LIMITS.tMin || k.t > LIMITS.tMax || k.p < LIMITS.pMin || k.p > LIMITS.pMax || k.m < 8 * k.p) {
    throw new LockedError('damaged', 'This file has key settings this app does not accept.');
  }
}

/** A master key for a batch of files: one Argon2id run, a fresh random salt. */
async function newMaster(password, kdf = KDF) {
  const salt = crypto.randomBytes(32);
  return { key: await deriveMaster(password, salt, kdf), salt, kdf: { ...kdf } };
}

const fileKey = (master, fileSalt) => Buffer.from(crypto.hkdfSync('sha256', master, fileSalt, INFO, 32));

function buildHeader(h) {
  const json = Buffer.from(JSON.stringify({
    cipher: 'aes-256-gcm', chunk: CHUNK, kdf: 'argon2id', argon2: { v: 19, m: h.kdf.m, t: h.kdf.t, p: h.kdf.p },
    salt: h.salt.toString('base64'), fileSalt: h.fileSalt.toString('base64'), noncePrefix: h.noncePrefix.toString('base64'),
  }), 'utf8');
  const pre = Buffer.alloc(PREFIX);
  MAGIC.copy(pre);
  pre.writeUInt16BE(VERSION, MAGIC.length);
  pre.writeUInt32BE(json.length, MAGIC.length + 2);
  return Buffer.concat([pre, json]);
}

/** Parses the clear header from the first bytes of a file. Returns { header, length } or throws. */
function parseHeader(buf) {
  if (buf.length < PREFIX || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new LockedError('not-locked', 'This is not a file made by File Encryptor (.locked).');
  const v = buf.readUInt16BE(MAGIC.length);
  if (v !== VERSION) throw new LockedError('version', `This file was made by a newer version of File Encryptor (format ${v}). Update the app to open it.`);
  const len = buf.readUInt32BE(MAGIC.length + 2);
  if (len < 2 || len > MAX_HEADER || buf.length < PREFIX + len) throw new LockedError('damaged', 'The file is damaged or cut short (its header is incomplete).');
  let h;
  try { h = JSON.parse(buf.subarray(PREFIX, PREFIX + len).toString('utf8')); } catch { throw new LockedError('damaged', 'The file is damaged (its header cannot be read).'); }
  const b64 = (s, n) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').length === n;
  if (!h || typeof h !== 'object' || Object.keys(h).sort().join() !== 'argon2,chunk,cipher,fileSalt,kdf,noncePrefix,salt' || h.cipher !== 'aes-256-gcm' || h.kdf !== 'argon2id' || h.chunk !== CHUNK
    || !h.argon2 || h.argon2.v !== 19 || Object.keys(h.argon2).sort().join() !== 'm,p,t,v' || !b64(h.salt, 32) || !b64(h.fileSalt, 32) || !b64(h.noncePrefix, NONCE_PREFIX)) {
    throw new LockedError('damaged', 'The file is damaged (its header is not valid).');
  }
  const kdf = { m: h.argon2.m, t: h.argon2.t, p: h.argon2.p };
  checkKdf(kdf);
  const raw = buf.subarray(0, PREFIX + len);
  return { kdf, salt: Buffer.from(h.salt, 'base64'), fileSalt: Buffer.from(h.fileSalt, 'base64'), noncePrefix: Buffer.from(h.noncePrefix, 'base64'), length: PREFIX + len, raw };
}

function nonceFor(prefix, counter) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, NONCE_PREFIX);
  return n;
}
const aadFor = (headerHash, last) => Buffer.concat([headerHash, Buffer.from([last ? 1 : 0])]);

function sealChunk(key, prefix, headerHash, counter, plain, last) {
  if (counter > 0xffffffff) throw new LockedError('too-big', 'The file is too large for this format.');
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(prefix, counter), { authTagLength: TAG });
  c.setAAD(aadFor(headerHash, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function openChunk(key, prefix, headerHash, counter, seg, last) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(prefix, counter), { authTagLength: TAG });
  d.setAAD(aadFor(headerHash, last));
  d.setAuthTag(seg.subarray(seg.length - TAG));
  return Buffer.concat([d.update(seg.subarray(0, seg.length - TAG)), d.final()]);
}

/**
 * Encrypts a plaintext stream into `out` (an open fs FileHandle). The plaintext is: u32 meta length, meta JSON, content.
 * `content` is an async iterable of Buffers. Returns { plainHash, contentBytes } (SHA-256 of the whole plaintext, for
 * the verification pass). Memory use is constant: at most two chunks are held.
 */
async function encryptStream({ master, meta, content, out, signal, onBytes }) {
  const fileSalt = crypto.randomBytes(32);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX);
  const header = buildHeader({ kdf: master.kdf, salt: master.salt, fileSalt, noncePrefix });
  const headerHash = crypto.createHash('sha256').update(header).digest();
  const key = fileKey(master.key, fileSalt);
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  if (metaBuf.length > MAX_META) throw new LockedError('meta', 'The file name is too long.');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(metaBuf.length);
  const hash = crypto.createHash('sha256');
  let pos = 0; // file offset
  const write = async (b) => { await out.write(b, 0, b.length, pos); pos += b.length; };
  await write(header);

  let counter = 0;
  let pending = null;                      // a full chunk we cannot seal until we know whether more follows
  let buf = Buffer.alloc(CHUNK); let fill = 0;
  let contentBytes = 0;
  const flushPending = async (last) => { await write(sealChunk(key, noncePrefix, headerHash, counter++, pending, last)); pending = null; };
  const take = async (data) => {
    hash.update(data);
    let off = 0;
    while (off < data.length) {
      const n = Math.min(CHUNK - fill, data.length - off);
      data.copy(buf, fill, off, off + n);
      fill += n; off += n;
      if (fill === CHUNK) {
        if (pending) await flushPending(false);
        pending = buf; buf = Buffer.alloc(CHUNK); fill = 0;
      }
    }
  };
  try {
    await take(lenBuf); await take(metaBuf);
    for await (const data of content) {
      if (signal && signal.aborted) throw cancelled();
      await take(data);
      contentBytes += data.length;
      if (onBytes) onBytes(data.length);
    }
    if (signal && signal.aborted) throw cancelled();
    if (fill > 0) { if (pending) await flushPending(false); pending = buf.subarray(0, fill); }
    else if (!pending) pending = Buffer.alloc(0); // only possible for an empty plaintext, which cannot happen (meta), but keep the rule
    await flushPending(true);
  } finally { key.fill(0); }
  return { plainHash: hash.digest('hex'), contentBytes, bytesWritten: pos };
}

/** Reads the header of a .locked file and works out the key, caching Argon2 results per (salt, settings) for a batch. */
async function keyForFile(fh, size, getMaster) {
  const head = Buffer.alloc(Math.min(size, PREFIX + MAX_HEADER));
  await fh.read(head, 0, head.length, 0);
  const h = parseHeader(head);
  const master = await getMaster(h.salt, h.kdf);
  return { h, key: fileKey(master, h.fileSalt), headerHash: crypto.createHash('sha256').update(h.raw).digest() };
}

/**
 * Decrypts `file`, calling onMeta(meta) once the name is known (it may return a sink), then sink.write(buf) for content.
 * Every chunk is authenticated before its plaintext is passed on; the very last check (that the file was not cut short)
 * happens at the end, which is why callers write to a .part file and rename only after this returns.
 * Returns { meta, plainHash, contentBytes }.
 */
async function decryptFile(file, { getMaster, onMeta, signal, onBytes }) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const { h, key, headerHash } = await keyForFile(fh, size, getMaster);
    const body = size - h.length;
    if (body < TAG) throw new LockedError('damaged', 'The file is cut short: there is no encrypted data after the header.');
    const chunks = Math.ceil(body / SEG);
    const lastLen = body - (chunks - 1) * SEG;
    if (lastLen < TAG) throw new LockedError('damaged', 'The file is cut short or has extra bytes at the end.');
    const hash = crypto.createHash('sha256');
    let meta = null; let sink = null; let metaNeed = null; let metaBuf = Buffer.alloc(0); let contentBytes = 0;
    const seg = Buffer.alloc(SEG);
    try {
      for (let i = 0; i < chunks; i++) {
        if (signal && signal.aborted) throw cancelled();
        const last = i === chunks - 1;
        const len = last ? lastLen : SEG;
        const { bytesRead } = await fh.read(seg, 0, len, h.length + i * SEG);
        if (bytesRead !== len) throw new LockedError('damaged', 'The file changed while it was being read.');
        let plain;
        try { plain = openChunk(key, h.noncePrefix, headerHash, i, seg.subarray(0, len), last); } catch {
          // Still a failure either way; trying the other last-chunk flag only tells the user WHAT happened.
          let flipped = false;
          try { openChunk(key, h.noncePrefix, headerHash, i, seg.subarray(0, len), !last); flipped = true; } catch { /* no */ }
          if (flipped && last) throw new LockedError('tampered', 'The file has been cut short (chunks are missing at the end). Nothing was saved.');
          if (flipped) throw new LockedError('tampered', 'The file has extra data after its real end. Nothing was saved.');
          if (i === 0) throw new LockedError('wrong-password', 'The password is wrong, or the file has been changed or damaged.');
          throw new LockedError('tampered', last ? 'The file has been cut short or changed at the end. Nothing was saved.' : `Part of the file (at ${Math.round((i * CHUNK) / 1024)} KiB) has been changed or damaged. Nothing was saved.`);
        }
        hash.update(plain);
        let p = plain;
        if (!meta) {
          metaBuf = Buffer.concat([metaBuf, p]);
          if (metaNeed == null && metaBuf.length >= 4) { metaNeed = metaBuf.readUInt32BE(0); if (metaNeed > MAX_META) throw new LockedError('damaged', 'The file is damaged (its description is too long).'); }
          if (metaNeed == null || metaBuf.length < 4 + metaNeed) { if (last) throw new LockedError('damaged', 'The file is damaged (it ends too early).'); continue; }
          try { meta = JSON.parse(metaBuf.subarray(4, 4 + metaNeed).toString('utf8')); } catch { throw new LockedError('damaged', 'The file is damaged (its description cannot be read).'); }
          if (!meta || typeof meta !== 'object') throw new LockedError('damaged', 'The file is damaged (its description is not valid).');
          p = metaBuf.subarray(4 + metaNeed);
          metaBuf = null;
          sink = await onMeta(meta);
        }
        if (p.length) { contentBytes += p.length; if (sink) await sink.write(p); if (onBytes) onBytes(p.length); }
      }
    } finally { key.fill(0); }
    if (!meta) throw new LockedError('damaged', 'The file is damaged.');
    if (sink && sink.end) await sink.end();
    return { meta, plainHash: hash.digest('hex'), contentBytes };
  } finally { await fh.close(); }
}

/** Header info without the password (to tell .locked files apart and show what they are). */
async function inspect(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(Math.min(size, PREFIX + MAX_HEADER));
    await fh.read(head, 0, head.length, 0);
    const h = parseHeader(head);
    return { kdf: h.kdf, size };
  } finally { await fh.close(); }
}

/** A cache of master keys for one batch: one Argon2id per distinct salt. */
function masterCache(password) {
  const cache = new Map();
  const get = async (salt, kdf) => {
    const k = salt.toString('hex') + JSON.stringify(kdf);
    if (!cache.has(k)) cache.set(k, deriveMaster(password, salt, kdf));
    return cache.get(k);
  };
  get.wipe = async () => { for (const p of cache.values()) { try { (await p).fill(0); } catch { /* ignore */ } } cache.clear(); };
  return get;
}

module.exports = { MAGIC, VERSION, CHUNK, SEG, TAG, KDF, LockedError, cancelled, deriveMaster, newMaster, fileKey, parseHeader, encryptStream, decryptFile, inspect, masterCache, sealChunk, openChunk };
