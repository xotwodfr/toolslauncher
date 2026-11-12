'use strict';
// The vault FILE: key derivation, encryption and the on-disk format. See FORMAT.md for the byte layout.
// Only well-known primitives: Argon2id (hash-wasm, the reference algorithm compiled to WebAssembly), SHA-256 and
// AES-256-GCM (Node's crypto, i.e. OpenSSL). Nothing here is home-made crypto; this file only arranges the pieces.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { argon2id } = require('hash-wasm');

const MAGIC = Buffer.from([0x50, 0x56, 0x4c, 0x54, 0x0d, 0x0a, 0x1a, 0x0a]); // "PVLT\r\n\x1a\n"
const VERSION = 1;
const PREFIX = MAGIC.length + 2 + 4; // magic, u16 version, u32 header length
const MAX_HEADER = 4096;
const TAG = 16;
const PAD = 1024; // the plaintext is padded with spaces to a multiple of this, so the size hides the exact contents
const MAX_FILE = 256 * 1024 * 1024;

// Argon2id parameter bounds. The lower bounds stop a tampered header from weakening a NEW save (we never write
// below them); the upper bounds stop a hostile file from making us allocate gigabytes. Tests may go lower.
const LIMITS = { mMin: 8 * 1024, mMax: 1024 * 1024, tMin: 1, tMax: 40, pMin: 1, pMax: 8 };
const DEFAULT_KDF = { m: 64 * 1024, t: 3, p: 1 }; // 64 MiB, 3 passes, 1 lane

class VaultError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

/** SHA-256 of a key file's whole content, read in a stream (any file can be a key file). */
async function hashKeyFile(file) {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new VaultError('keyfile', 'The key file could not be found.');
  if (st.size === 0) throw new VaultError('keyfile', 'The key file is empty, so it cannot be used as a key.');
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', () => reject(new VaultError('keyfile', 'The key file could not be read.'))).on('end', () => resolve(h.digest()));
  });
}

/** Writes a new random key file (64 random bytes). Refuses to overwrite. */
async function createKeyFile(file) {
  const fh = await fs.promises.open(file, 'wx', 0o600);
  try { await fh.writeFile(crypto.randomBytes(64)); await fh.sync(); } finally { await fh.close(); }
}

/** KeePass-style composite key: SHA-256( SHA-256(password) [|| SHA-256(key file)] ). The password is NFC-normalised. */
function compositeKey(password, keyFileHash) {
  if (typeof password !== 'string' || !password.length) throw new VaultError('password', 'Type the master password.');
  const pw = sha256(Buffer.from(password.normalize('NFC'), 'utf8'));
  return keyFileHash ? sha256(pw, keyFileHash) : sha256(pw);
}

function checkKdf(k, limits = LIMITS) {
  const int = (v) => Number.isInteger(v);
  if (!k || !int(k.m) || !int(k.t) || !int(k.p) || k.m < limits.mMin || k.m > limits.mMax || k.t < limits.tMin || k.t > limits.tMax || k.p < limits.pMin || k.p > limits.pMax || k.m < 8 * k.p) {
    throw new VaultError('damaged', 'The vault file has key settings this app does not accept, so it was not opened.');
  }
}

/** Argon2id -> 32-byte AES key. */
async function deriveKey(composite, salt, kdf, limits = LIMITS) {
  checkKdf(kdf, limits);
  const out = await argon2id({ password: composite, salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' });
  return Buffer.from(out);
}

/** Picks Argon2id settings: 64 MiB and enough passes that one derivation takes about targetMs (0.5-1 s on this machine). */
async function calibrate(targetMs = 750) {
  const probe = { ...DEFAULT_KDF, t: 2 };
  await deriveKey(Buffer.alloc(32), Buffer.alloc(16), { ...DEFAULT_KDF, t: 1 }); // warm-up (WebAssembly start-up)
  const t0 = Date.now();
  await deriveKey(Buffer.alloc(32), Buffer.alloc(16), probe);
  const perPass = Math.max(1, (Date.now() - t0) / probe.t);
  const t = Math.min(LIMITS.tMax, Math.max(DEFAULT_KDF.t, Math.round(targetMs / perPass)));
  return { m: DEFAULT_KDF.m, t, p: DEFAULT_KDF.p };
}

function buildHeader(h) {
  return Buffer.from(JSON.stringify({
    cipher: 'aes-256-gcm', kdf: 'argon2id', argon2: { v: 19, m: h.kdf.m, t: h.kdf.t, p: h.kdf.p },
    salt: h.salt.toString('base64'), nonce: h.nonce.toString('base64'), keyFile: !!h.keyFile,
  }), 'utf8');
}

/** Reads and strictly validates the plain-text part of a vault file. Does not need the password. */
function parse(buf, limits = LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < PREFIX || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new VaultError('not-vault', 'This is not a Password Vault file.');
  const version = buf.readUInt16BE(MAGIC.length);
  if (version !== VERSION) throw new VaultError('version', `This vault was made by a newer version of Password Vault (format ${version}). Update the app to open it.`);
  const hlen = buf.readUInt32BE(MAGIC.length + 2);
  if (hlen < 2 || hlen > MAX_HEADER || buf.length < PREFIX + hlen + TAG) throw new VaultError('damaged', 'The vault file is damaged or cut short.');
  let h;
  try { h = JSON.parse(buf.subarray(PREFIX, PREFIX + hlen).toString('utf8')); } catch { throw new VaultError('damaged', 'The vault file is damaged (its header cannot be read).'); }
  const keys = ['argon2', 'cipher', 'kdf', 'keyFile', 'nonce', 'salt'];
  const b64 = (s, n) => typeof s === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && Buffer.from(s, 'base64').length === n;
  if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).sort().join() !== keys.join() || h.cipher !== 'aes-256-gcm' || h.kdf !== 'argon2id'
    || !h.argon2 || h.argon2.v !== 19 || Object.keys(h.argon2).sort().join() !== 'm,p,t,v' || !b64(h.salt, 32) || !b64(h.nonce, 12) || typeof h.keyFile !== 'boolean') {
    throw new VaultError('damaged', 'The vault file is damaged (its header is not valid).');
  }
  const kdf = { m: h.argon2.m, t: h.argon2.t, p: h.argon2.p };
  checkKdf(kdf, limits);
  return {
    kdf, salt: Buffer.from(h.salt, 'base64'), nonce: Buffer.from(h.nonce, 'base64'), keyFile: h.keyFile,
    aad: buf.subarray(0, PREFIX + hlen), body: buf.subarray(PREFIX + hlen, buf.length - TAG), tag: buf.subarray(buf.length - TAG),
  };
}

/** Encrypts the vault object with a FRESH random 96-bit nonce. kdf/salt/keyFile go into the authenticated header. */
function seal(key, meta, data) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('bad key');
  const nonce = crypto.randomBytes(12);
  const header = buildHeader({ ...meta, nonce });
  const prefix = Buffer.alloc(PREFIX);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt16BE(VERSION, MAGIC.length);
  prefix.writeUInt32BE(header.length, MAGIC.length + 2);
  const aad = Buffer.concat([prefix, header]);
  let json = JSON.stringify(data);
  const bytes = Buffer.byteLength(json, 'utf8');
  json += ' '.repeat((PAD - (bytes % PAD)) % PAD);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  c.setAAD(aad);
  const body = Buffer.concat([c.update(json, 'utf8'), c.final()]);
  return Buffer.concat([aad, body, c.getAuthTag()]);
}

/** Decrypts with an already derived key. Any change to any byte (header or body) makes this throw 'wrong-key'. */
function open(key, buf, limits = LIMITS) {
  const p = parse(buf, limits);
  let text;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, p.nonce, { authTagLength: TAG });
    d.setAAD(p.aad);
    d.setAuthTag(p.tag);
    text = Buffer.concat([d.update(p.body), d.final()]).toString('utf8');
  } catch {
    throw new VaultError('wrong-key', p.keyFile ? 'The master password or the key file is wrong, or the vault file has been changed or damaged.' : 'The master password is wrong, or the vault file has been changed or damaged.');
  }
  try { return { data: JSON.parse(text), meta: { kdf: p.kdf, salt: p.salt, keyFile: p.keyFile } }; } catch { throw new VaultError('damaged', 'The vault decrypted but its contents are not valid.'); }
}

/** Password (+ key file hash) -> { key, data, meta }. */
async function unlock(buf, password, keyFileHash, limits = LIMITS) {
  const p = parse(buf, limits);
  if (p.keyFile && !keyFileHash) throw new VaultError('keyfile-needed', 'This vault also needs its key file. Choose the key file and try again.');
  if (!p.keyFile && keyFileHash) throw new VaultError('keyfile-unexpected', 'This vault does not use a key file. Remove the key file and try again.');
  const key = await deriveKey(compositeKey(password, keyFileHash), p.salt, p.kdf, limits);
  const r = open(key, buf, limits);
  return { key, data: r.data, meta: r.meta };
}

/** A new key from a new password: fresh salt. */
async function newKey(password, keyFileHash, kdf, limits = LIMITS) {
  const salt = crypto.randomBytes(32);
  const key = await deriveKey(compositeKey(password, keyFileHash), salt, kdf, limits);
  return { key, meta: { kdf: { ...kdf }, salt, keyFile: !!keyFileHash } };
}

async function readVaultFile(file) {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new VaultError('missing', 'The vault file could not be found. It may have been moved or renamed.');
  if (st.size > MAX_FILE) throw new VaultError('not-vault', 'This file is far too large to be a vault.');
  return fs.promises.readFile(file);
}

/**
 * Atomic save: write "<file>.part", flush it to disk, read it back and check it decrypts (with `verify`), then move the
 * current vault to "<file>.bak" (replacing the older backup) and rename the new one into place. A crash at any point
 * leaves either the old or the new vault under the real name, never half a file.
 */
async function writeAtomic(file, buf, { backup = true, verify } = {}) {
  const part = `${file}.part`;
  const fh = await fs.promises.open(part, 'w', 0o600);
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
  try {
    const back = await fs.promises.readFile(part);
    if (!back.equals(buf)) throw new Error('The new vault file did not read back the same. Nothing was replaced.');
    if (verify) verify(back);
    const exists = await fs.promises.stat(file).then((s) => s.isFile(), () => false);
    if (exists && backup) {
      const bak = `${file}.bak`;
      await fs.promises.copyFile(file, `${bak}.part`);
      await fs.promises.rename(`${bak}.part`, bak);
    }
    await fs.promises.rename(part, file);
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
  try { // flush the directory entry too (POSIX); not possible on Windows, where rename is already durable enough
    if (process.platform !== 'win32') { const d = await fs.promises.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); } }
  } catch { /* best effort */ }
}

module.exports = {
  MAGIC, VERSION, LIMITS, DEFAULT_KDF, VaultError, PAD,
  hashKeyFile, createKeyFile, compositeKey, deriveKey, calibrate, parse, seal, open, unlock, newKey, readVaultFile, writeAtomic,
};
