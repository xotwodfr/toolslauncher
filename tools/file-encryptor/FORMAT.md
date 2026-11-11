# The `.locked` file format (version 1)

One `.locked` file holds one encrypted file or one encrypted folder. It is streamed: files of any size are encrypted
and decrypted with constant memory. `src/locked.js` is the reference code and `test/encryptor.test.js` contains an
independent reader for the first chunk built only from this description.

Primitives (all standard, none home-made): **Argon2id** (RFC 9106, `hash-wasm`), **HKDF-SHA256** (RFC 5869),
**SHA-256** and **AES-256-GCM** (Node.js `crypto`). The chunking is the **STREAM** construction (Hoang, Reyhanitabar,
Rogaway, Vizár, "Online Authenticated-Encryption and its Nonce-Reuse Misuse-Resistance", 2015), the same idea used by
Google Tink's streaming AEAD and by age.

## Layout

| Offset | Size | Contents |
|---|---|---|
| 0 | 8 | Magic `46 45 4E 43 0D 0A 1A 0A` (`"FENC\r\n\x1a\n"`) |
| 8 | 2 | Version, unsigned big-endian, `1` |
| 10 | 4 | Header length `H` (2 ≤ H ≤ 4096), unsigned big-endian |
| 14 | H | Header, UTF-8 JSON (in clear) |
| 14+H | … | Chunks: each is up to 65,536 bytes of ciphertext followed by its 16-byte GCM tag |

Header:

```json
{"cipher":"aes-256-gcm","chunk":65536,"kdf":"argon2id","argon2":{"v":19,"m":65536,"t":3,"p":1},
 "salt":"<base64, 32 bytes>","fileSalt":"<base64, 32 bytes>","noncePrefix":"<base64, 8 bytes>"}
```

Exactly these keys. Readers must bound the Argon2 settings before running it (this app accepts 8 MiB ≤ m ≤ 1 GiB,
1 ≤ t ≤ 40, 1 ≤ p ≤ 8). The header holds no names: the original name is inside the encrypted data.

## Keys

```
master  = Argon2id(password = UTF-8(NFC(password)), salt, t, m, p, 32 bytes)
fileKey = HKDF-SHA256(ikm = master, salt = fileSalt, info = "file-encryptor/v1 payload key", 32 bytes)
```

`salt` is random per batch (one Argon2id run per Encrypt click, so 100 files do not take 100 key derivations);
`fileSalt` and `noncePrefix` are random per file, so every file has its own key and a fresh nonce space.

## Chunks

The plaintext stream is split into 65,536-byte chunks (the last may be shorter; it is never empty unless the whole
plaintext is, which cannot happen). Chunk `i` (counting from 0) is sealed with AES-256-GCM:

```
nonce = noncePrefix (8 bytes) || uint32_be(i)
aad   = SHA-256(bytes 0 … 14+H−1 of the file) || (0x01 if this is the last chunk else 0x00)
```

So: changing the header breaks every chunk (it is in the AAD); reordering, dropping or duplicating chunks breaks the
counter; cutting the file at a chunk boundary leaves a last chunk sealed with flag 0 that does not open with flag 1;
appending data does the opposite. When the ciphertext length is a multiple of 65,552, the last chunk is a full one.
The number of chunks is `ceil((fileSize − 14 − H) / 65552)`.

## Plaintext

```
uint32_be(metaLength) || meta (UTF-8 JSON) || content
```

* file: `{"v":1,"kind":"file","name":"report.pdf","bytes":12345,"mtime":<ms since 1970>}`; content = the file's bytes.
* folder: `{"v":1,"kind":"folder","name":"Photos","bytes":…,"files":…,"folders":…,"mtime":…}`; content = an archive:

```
repeat:  uint8 type (1 = folder, 2 = file, 0 = end) | uint16_be pathLength | path (UTF-8, "/"-separated, relative)
         files only: uint64_be size | uint64_be mtime (ms) | size bytes of data
end:     a single 0x00
```

Folders come before their contents; links and special files are not stored. Readers must refuse absolute paths,
`..`, `.`, empty parts, backslashes, drive letters and control characters, and must not write outside the target.

## Decrypting safely

Every chunk is authenticated before its plaintext is used, but truncation is only known at the end, so output goes to
`<name>.part` (or a hidden temporary folder) and is renamed to the original name only after the last chunk checks out;
on any failure it is deleted. An existing file is never replaced: the output becomes `name (2).ext`.
