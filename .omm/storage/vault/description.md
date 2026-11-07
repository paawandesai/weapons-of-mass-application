Per-tenant data key wrapped by the environment master key; secrets sealed with AEAD. `get`, `put`, `rotate`; corrupt or tampered rows surface as `VaultKeyError`, never as plaintext.
