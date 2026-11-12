# Password Vault file format (version 1)

A vault is ONE file, normally named `*.pwvault`. Everything in it except a small header is encrypted and
authenticated. This document is enough to write an independent reader; `src/vaultfile.js` is the reference code.

Only standard primitives are used: **Argon2id** (RFC 9106; the reference algorithm compiled to WebAssembly by
`hash-wasm`), **SHA-256** and **AES-256-GCM** (Node.js `crypto`, i.e. OpenSSL). Nothing is home-made.

## Byte layout

| Offset | Size | Contents |
|---|---|---|
| 0 | 8 | Magic: `50 56 4C 54 0D 0A 1A 0A` (`"PVLT\r\n\x1a\n"`, so text-mode corruption is noticed) |
| 8 | 2 | Format version, unsigned big-endian. Currently `1` |
| 10 | 4 | Header length `H`, unsigned big-endian (2 ≤ H ≤ 4096) |
| 14 | H | Header: UTF-8 JSON (below), stored in clear but authenticated |
| 14+H | n | Ciphertext (AES-256-GCM) |
| end−16 | 16 | GCM authentication tag |

**Associated data (AAD)** for GCM = bytes `0 … 14+H−1` (magic, version, length and the whole header). Changing any
header byte, including the Argon2 settings, salt or nonce, makes decryption fail.

## Header

```json
{"cipher":"aes-256-gcm","kdf":"argon2id","argon2":{"v":19,"m":65536,"t":5,"p":1},
 "salt":"<base64, 32 bytes>","nonce":"<base64, 12 bytes>","keyFile":false}
```

* Exactly these keys; anything else is rejected. `argon2.v` is the Argon2 version (19 = 0x13).
* `m` memory in KiB, `t` passes, `p` lanes. Readers must bound them before running Argon2 (this app accepts
  8 MiB ≤ m ≤ 1 GiB, 1 ≤ t ≤ 40, 1 ≤ p ≤ 8) so a hostile file cannot exhaust memory.
* New vaults use m = 64 MiB, p = 1 and t calibrated so one derivation takes about 0.5–1 s on the creating computer
  (never fewer than 3 passes).
* `salt` is 32 random bytes, made new whenever the master password or key file changes.
* `nonce` is 12 random bytes (`crypto.randomBytes`), made new on **every** save. The key only changes with the
  password, so a vault would need billions of saves before random nonces risk repeating.
* `keyFile` says whether a key file is needed (it is not a secret, it lets the lock screen ask for one).

## Key derivation

```
pw        = UTF-8 bytes of the master password after Unicode NFC normalisation
composite = SHA-256( SHA-256(pw) )                         without a key file
composite = SHA-256( SHA-256(pw) || SHA-256(keyfile) )     with a key file (the whole file's bytes, any file)
key       = Argon2id(password = composite, salt, t, m, p, output 32 bytes)   (no secret, no associated data)
```

This is the same composite-key arrangement KeePass uses. Key files made by the app are 64 random bytes.

## Plaintext

UTF-8 JSON, padded at the end with ASCII spaces to a multiple of 1024 bytes (trailing spaces are valid JSON) so the
file size does not reveal the exact contents:

```json
{"schema":1,"created":"ISO-8601","modified":"ISO-8601",
 "settings":{"autoLockMinutes":5,"clipboardSeconds":30,"lockOnMinimize":false},
 "folders":["Work","Work/Servers"],
 "entries":[{"id":"uuid","title":"","username":"","password":"","urls":[""],"notes":"","tags":[""],
             "folder":"Work/Servers","favorite":false,
             "fields":[{"name":"","value":"","hidden":true}],
             "totp":{"secret":"BASE32","algorithm":"SHA1","digits":6,"period":30} | null,
             "history":[{"password":"","until":"ISO-8601"}],
             "created":"ISO-8601","modified":"ISO-8601","trashed":"ISO-8601" | null}]}
```

Readers should ignore unknown fields. `schema` greater than 1 means a newer app wrote it.

## Saving

1. Encrypt with a fresh nonce, write `<vault>.part`, `fsync` it, read it back, check it is byte-identical and decrypts.
2. Copy the current vault to `<vault>.bak.part`, rename that to `<vault>.bak` (the previous save; it opens with the
   password that was valid for it).
3. Rename `<vault>.part` over `<vault>`. A crash leaves either the old or the new vault in place, never half a file.

If the vault on disk changed since it was read (another computer, a sync program), that version is first copied to
`<name> (changed elsewhere YYYY-MM-DD-HH-MM-SS).pwvault` before saving, so nothing is lost silently.

## Encrypted backup / CSV export

* *Save encrypted backup* writes the same format (same key, new nonce) to a new file.
* *Export unencrypted CSV* writes Bitwarden's columns
  (`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`) in plain text.
