import { KEY_BYTES } from './cipher';

export const MASTER_KEY_ERROR = 'vault: VAULT_MASTER_KEY missing or not 32 bytes';

export class VaultConfigError extends Error {
  readonly code = 'vault_not_configured' as const;
  constructor() {
    super(MASTER_KEY_ERROR);
    this.name = 'VaultConfigError';
  }
}

/** Parses a base64 32-byte key from the environment. Throws `VaultConfigError` otherwise. */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.VAULT_MASTER_KEY?.trim();
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new VaultConfigError();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new VaultConfigError();
  return key;
}

let cached: Buffer | null = null;

/** Master key, read from the environment once per process. */
export function masterKey(): Buffer {
  cached ??= loadMasterKey();
  return cached;
}

/**
 * Startup check for api and worker `main.ts`: call before serving. Throws `VaultConfigError`
 * (uncaught at startup, so the process exits non-zero) when the key is missing or not 32 bytes.
 */
export function assertVaultConfigured(): void {
  masterKey();
}
