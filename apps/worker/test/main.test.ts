import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { vault } from '@wma/db';

const root = resolve(import.meta.dirname, '..');

/** Runs the real worker entrypoint with a database that cannot be reached. */
function runWorker(vaultKey: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      // Valid LLM configuration, unreachable database: only the vault check can explain an early exit.
      ANTHROPIC_API_KEY: 'sk-test-not-real',
      DATABASE_URL: 'postgres://wma:wma@127.0.0.1:1/none',
      // An empty value (not a missing one) keeps dotenv from filling it in from a local .env.
      VAULT_MASTER_KEY: vaultKey,
    },
    encoding: 'utf8',
    input: '',
    timeout: 30_000,
  });
}

describe('worker entrypoint', () => {
  it.each([
    ['missing', ''],
    ['not 32 bytes', Buffer.alloc(16).toString('base64')],
    ['not base64', '!!!not base64!!!'],
  ])('exits non-zero before starting pg-boss when VAULT_MASTER_KEY is %s', (_name, key) => {
    const r = runWorker(key);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(vault.MASTER_KEY_ERROR);
    expect(r.stdout).not.toContain('worker started');
  });
});
