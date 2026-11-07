# Design brief: credential vault

Purpose: store per-tenant secrets (Google refresh tokens, ATS passwords) so that only code holding a tenant handle can read them back, and so a database dump alone reveals nothing. Read by the Google client wrapper and the ATS account module.

Inputs: `VAULT_MASTER_KEY` env (32 bytes, base64, read once at process start); tenant handle from `db.forTenant`; plaintext secret (UTF-8 string, max 8 KiB); `kind` enum `google_refresh_token | ats_password`; `ref` string (max 200 chars, e.g. `greenhouse:acme`).

Units: bytes everywhere. Keys are 32 bytes. IV is 12 bytes, random per encryption. Auth tag is 16 bytes. Base64 only at the env boundary.

Rules:
1. Process start without a valid 32-byte master key MUST exit non-zero before serving; violation text `vault: VAULT_MASTER_KEY missing or not 32 bytes`.
2. First `put` for a tenant MUST create exactly one `vault_keys` row: a random 32-byte DEK, wrapped with AES-256-GCM under the master key, with its own IV and tag. Concurrent first puts MUST serialize on a unique index on `vault_keys.tenant_id`; the loser re-reads.
3. Every secret ciphertext MUST be AES-256-GCM under the tenant DEK with a fresh random IV; `(ciphertext, iv, tag)` stored, plaintext never stored or logged.
4. The AAD for every secret encryption MUST be `tenant_id || kind || ref` so a row moved between tenants or renamed fails to decrypt.
5. `get(handle, kind, ref)` MUST filter by the handle's tenant_id; a row of another tenant MUST return `not_found`, never a decrypt error (the row is invisible, see tenancy brief).
6. `put` for an existing `(tenant_id, kind, ref)` MUST overwrite in place and set `rotated_at = now()`; unique index on that triple.
7. `delete` MUST remove the row; a following `get` returns `not_found`.
8. A decrypt failure (tag mismatch) MUST return `corrupt`, write an activity log entry `vault_decrypt_failed` with kind and ref only, and never throw plaintext or key material.
9. The vault module is the only module that imports `node:crypto` cipher functions; a lint rule enforces it.
10. Every `put`, `rotate`, `delete` MUST write exactly one activity log entry with `{kind, ref}` in detail and nothing else.

Edge cases: an empty-string secret is valid (stored encrypted). A `ref` with a colon is fine. Two tenants with the same `ref` are independent rows. Rotating the master key is out of scope (documented runbook).

Time: `created_at`, `rotated_at` are UTC timestamptz from the database clock.

Failure handling: per-call. A failed put throws to the caller and writes no partial row (single insert). Missing DEK row on `get` returns `not_found`.

Consistency: DEK creation and the first secret insert happen in one transaction.

Outputs: functions `put`, `get`, `delete`, `rotate` (= put with a new DEK is NOT rotate; rotate re-encrypts the same plaintext with a fresh IV); activity log entries per rule 10; no log line contains plaintext, DEK or master key.

Tests: one per rule 1 to 10; cross-tenant get via a second handle; corrupt tag flipped by one byte; concurrent first-put with two handles for the same tenant; AAD tamper (change `ref` in the row, expect `corrupt`).

Out of scope: KMS, master-key rotation, secret versioning, caching decrypted values.
