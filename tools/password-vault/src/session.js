'use strict';
// An open vault: which file, the derived key, the decrypted contents, and saving. Lives only in the main process.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const F = require('./vaultfile');
const V = require('./vault');

const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class Session {
  constructor({ limits } = {}) {
    this.limits = limits || F.LIMITS;
    this.file = null; this.key = null; this.meta = null; this.data = null; this.diskHash = null;
  }

  get unlocked() { return !!this.key; }

  /** Creates a NEW vault file. Refuses to replace an existing file. */
  async create(file, password, keyFileHash, kdf) {
    if (fs.existsSync(file)) throw new F.VaultError('exists', 'A file with that name already exists. Choose a new name for the vault.');
    const nk = await F.newKey(password, keyFileHash, kdf || await F.calibrate(), this.limits);
    this.close();
    Object.assign(this, { file, key: nk.key, meta: nk.meta, data: V.empty() });
    await this.save();
  }

  async unlock(file, password, keyFileHash) {
    const buf = await F.readVaultFile(file);
    const r = await F.unlock(buf, password, keyFileHash, this.limits);
    let data;
    try { data = V.normalise(r.data); } catch (e) { r.key.fill(0); throw new F.VaultError('damaged', e.message); }
    this.close();
    Object.assign(this, { file, key: r.key, meta: r.meta, data, diskHash: digest(buf) });
  }

  /** Forgets the key and the contents. (The key buffer is zeroed; JavaScript strings cannot be wiped, they are dropped.) */
  close() {
    if (this.key) this.key.fill(0);
    this.key = null; this.data = null; this.meta = null;
  }

  lock() { const f = this.file; this.close(); this.file = f; }

  /**
   * Encrypts with a fresh nonce and saves atomically, keeping the previous file as .bak. If the file was changed by
   * something else since we read it (a sync program, another copy of the app), that version is first kept next to it
   * as "<name> (changed elsewhere <time>).<ext>" so nothing is lost; its path is returned.
   */
  async save() {
    if (!this.unlocked) throw new Error('The vault is locked.');
    let conflict = null;
    const current = await fs.promises.readFile(this.file).catch(() => null);
    if (current && this.diskHash && digest(current) !== this.diskHash) {
      const ext = path.extname(this.file);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      conflict = path.join(path.dirname(this.file), `${path.basename(this.file, ext)} (changed elsewhere ${stamp})${ext}`);
      await fs.promises.copyFile(this.file, conflict, fs.constants.COPYFILE_EXCL);
    }
    const buf = F.seal(this.key, this.meta, this.data);
    await F.writeAtomic(this.file, buf, { backup: true, verify: (b) => F.open(this.key, b, this.limits) });
    this.diskHash = digest(buf);
    return { conflict };
  }

  /** Checks a password (+ key file) against the open vault without changing anything. */
  async verify(password, keyFileHash) {
    if (!this.unlocked) return false;
    if (!!keyFileHash !== !!this.meta.keyFile) return false;
    const k = await F.deriveKey(F.compositeKey(password, keyFileHash), this.meta.salt, this.meta.kdf, this.limits);
    const ok = crypto.timingSafeEqual(k, this.key);
    k.fill(0);
    return ok;
  }

  /** New master password and/or key file: new salt, new key, re-encrypted and saved. */
  async changeMaster(currentPassword, currentKeyFileHash, nextPassword, nextKeyFileHash, kdf) {
    if (!(await this.verify(currentPassword, currentKeyFileHash))) throw new F.VaultError('wrong-key', 'The current master password (or key file) is not right.');
    const nk = await F.newKey(nextPassword, nextKeyFileHash, kdf || this.meta.kdf, this.limits);
    const old = { key: this.key, meta: this.meta };
    this.key = nk.key; this.meta = nk.meta;
    try { await this.save(); } catch (e) { nk.key.fill(0); this.key = old.key; this.meta = old.meta; throw e; }
    old.key.fill(0);
  }

  /** An encrypted copy (same password and key file) at another place. Never replaces an existing file. */
  async exportBackup(dest) {
    if (!this.unlocked) throw new Error('The vault is locked.');
    if (fs.existsSync(dest)) throw new Error('A file with that name already exists.');
    const buf = F.seal(this.key, this.meta, this.data);
    await F.writeAtomic(dest, buf, { backup: false, verify: (b) => F.open(this.key, b, this.limits) });
  }
}

module.exports = { Session };
