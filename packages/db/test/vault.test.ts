import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { activity, vault, type TenantHandle } from '../src';
import { setupEnv, TEST_VAULT_MASTER_KEY, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await env.cleanup();
});

const SECRET = 'ya29.super-secret-refresh-token-VALUE';
const KIND = 'google_refresh_token' as const;

async function rowOf(tenantId: string, ref: string) {
  const r = await env.owner.query('select * from secrets where tenant_id = $1 and ref = $2', [
    tenantId,
    ref,
  ]);
  return r.rows[0];
}
const actions = async (t: { handle: TenantHandle; userId: string }) =>
  (await activity.listByUser(t.handle, t.userId, {})).map((e) => e.action);

describe('rule 1: master key startup check', () => {
  const msg = 'vault: VAULT_MASTER_KEY missing or not 32 bytes';
  it('rejects missing, short and non-base64 keys', () => {
    expect(() => vault.loadMasterKey({})).toThrow(msg);
    expect(() => vault.loadMasterKey({ VAULT_MASTER_KEY: '' })).toThrow(msg);
    expect(() =>
      vault.loadMasterKey({ VAULT_MASTER_KEY: Buffer.alloc(31).toString('base64') }),
    ).toThrow(msg);
    expect(() => vault.loadMasterKey({ VAULT_MASTER_KEY: '!!!not base64!!!' })).toThrow(msg);
    expect(vault.loadMasterKey({ VAULT_MASTER_KEY: TEST_VAULT_MASTER_KEY })).toHaveLength(32);
  });
  it('a process without the key exits non-zero before serving; with it, exits 0', () => {
    const run = (key: string | undefined) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'test/fixtures/assert-vault.ts'], {
        cwd: resolve(import.meta.dirname, '..'),
        env: { ...process.env, VAULT_MASTER_KEY: key, PATH: process.env.PATH },
        encoding: 'utf8',
        input: '',
      });
    const bad = run(undefined);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).not.toContain('serving');
    expect(bad.stderr).toContain(msg);
    const good = run(TEST_VAULT_MASTER_KEY);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('serving');
  });
});

describe('rule 2: one DEK per tenant, wrapped', () => {
  it('first put creates exactly one wrapped vault_keys row', async () => {
    const t = await env.makeTenant();
    expect(
      (await env.owner.query('select 1 from vault_keys where tenant_id=$1', [t.id])).rowCount,
    ).toBe(0);
    await vault.put(t.handle, t.userId, KIND, 'google:a', SECRET);
    await vault.put(t.handle, t.userId, KIND, 'google:b', SECRET);
    const r = await env.owner.query('select * from vault_keys where tenant_id=$1', [t.id]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].wrapped_dek).toHaveLength(32);
    expect(r.rows[0].wrap_iv).toHaveLength(12);
    expect(r.rows[0].wrap_tag).toHaveLength(16);
  });
  it('concurrent first puts from two handles yield one row and both secrets readable', async () => {
    const t = await env.makeTenant();
    const h2 = env.db.forTenant(t.id);
    await Promise.all([
      vault.put(t.handle, t.userId, KIND, 'google:one', 'one'),
      vault.put(h2, t.userId, 'ats_password', 'ats:two', 'two'),
    ]);
    const r = await env.owner.query('select 1 from vault_keys where tenant_id=$1', [t.id]);
    expect(r.rowCount).toBe(1);
    expect(await vault.get(t.handle, t.userId, KIND, 'google:one')).toEqual({
      ok: true,
      value: 'one',
    });
    expect(await vault.get(h2, t.userId, 'ats_password', 'ats:two')).toEqual({
      ok: true,
      value: 'two',
    });
  });
});

describe('rules 3 and 4: ciphertext-only rows, AAD binding', () => {
  it('stores only ciphertext, 12-byte IV, 16-byte tag; fresh IV per encryption', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'r1', SECRET);
    const a = await rowOf(t.id, 'r1');
    expect(a.iv).toHaveLength(12);
    expect(a.tag).toHaveLength(16);
    expect(a.ciphertext).toHaveLength(Buffer.byteLength(SECRET));
    expect(a.ciphertext.toString('utf8')).not.toContain('secret');
    expect(a.ciphertext.includes(Buffer.from(SECRET))).toBe(false);
    await vault.put(t.handle, t.userId, KIND, 'r1', SECRET);
    const b = await rowOf(t.id, 'r1');
    expect(b.iv.equals(a.iv)).toBe(false);
    expect(b.ciphertext.equals(a.ciphertext)).toBe(false);
  });
  it('a renamed ref fails to decrypt (AAD tamper)', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'orig', SECRET);
    await env.owner.query('update secrets set ref=$1 where tenant_id=$2', ['renamed', t.id]);
    expect(await vault.get(t.handle, t.userId, KIND, 'renamed')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
  it('a changed kind fails to decrypt', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, 'ats_password', 'k', SECRET);
    await env.owner.query(`update secrets set kind='google_refresh_token' where tenant_id=$1`, [
      t.id,
    ]);
    expect(await vault.get(t.handle, t.userId, KIND, 'k')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
});

describe('rule 5: tenant isolation', () => {
  it('another tenant gets not_found, never corrupt, for the same ref', async () => {
    const a = await env.makeTenant();
    const b = await env.makeTenant();
    await vault.put(a.handle, a.userId, KIND, 'shared:ref', SECRET);
    expect(await vault.get(b.handle, b.userId, KIND, 'shared:ref')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await vault.del(b.handle, b.userId, KIND, 'shared:ref')).toBe(false);
    expect(await vault.rotate(b.handle, b.userId, KIND, 'shared:ref')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    // Same ref in two tenants are independent rows.
    await vault.put(b.handle, b.userId, KIND, 'shared:ref', 'other');
    expect(await vault.get(a.handle, a.userId, KIND, 'shared:ref')).toEqual({
      ok: true,
      value: SECRET,
    });
    expect(await vault.get(b.handle, b.userId, KIND, 'shared:ref')).toEqual({
      ok: true,
      value: 'other',
    });
  });
});

describe('rules 6 and 7: overwrite and delete', () => {
  it('put overwrites in place and sets rotated_at', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'ow', 'v1');
    const first = await rowOf(t.id, 'ow');
    expect(first.rotated_at).toBeNull();
    await vault.put(t.handle, t.userId, KIND, 'ow', 'v2');
    const second = await rowOf(t.id, 'ow');
    expect(second.id).toBe(first.id);
    expect(second.rotated_at).not.toBeNull();
    expect(
      (await env.owner.query('select 1 from secrets where tenant_id=$1', [t.id])).rowCount,
    ).toBe(1);
    expect(await vault.get(t.handle, t.userId, KIND, 'ow')).toEqual({ ok: true, value: 'v2' });
  });
  it('delete removes the row and get then returns not_found', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'del', 'v');
    expect(await vault.delete(t.handle, t.userId, KIND, 'del')).toBe(true);
    expect(await rowOf(t.id, 'del')).toBeUndefined();
    expect(await vault.get(t.handle, t.userId, KIND, 'del')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('rule 8: decrypt failure', () => {
  it('a one-byte tag flip returns corrupt and logs vault_decrypt_failed with kind and ref only', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'flip', SECRET);
    await env.owner.query(
      `update secrets set tag = set_byte(tag, 0, get_byte(tag, 0) # 1) where tenant_id=$1`,
      [t.id],
    );
    const res = await vault.get(t.handle, t.userId, KIND, 'flip');
    expect(res).toEqual({ ok: false, reason: 'corrupt' });
    const log = await activity.listByUser(t.handle, t.userId, {});
    expect(log[0]).toMatchObject({
      action: 'vault_decrypt_failed',
      detail: { kind: KIND, ref: 'flip' },
    });
    expect(Object.keys(log[0]!.detail as object).sort()).toEqual(['kind', 'ref']);
  });
  it('a tampered wrapped DEK returns corrupt, not a throw', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'dek', SECRET);
    await env.owner.query(
      `update vault_keys set wrapped_dek = set_byte(wrapped_dek, 0, get_byte(wrapped_dek, 0) # 1) where tenant_id=$1`,
      [t.id],
    );
    expect(await vault.get(t.handle, t.userId, KIND, 'dek')).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
});

describe('rule 9: only the vault imports cipher functions', () => {
  it('lint rejects createCipheriv outside the vault and allows it inside', async () => {
    const root = resolve(import.meta.dirname, '../../..');
    const eslint = new ESLint({ cwd: root });
    const code = `import { createCipheriv } from 'node:crypto';\nexport const x = createCipheriv;\n`;
    const outside = await eslint.lintText(code, {
      filePath: resolve(root, 'packages/db/src/repos/x.ts'),
    });
    expect(outside[0]!.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
    const ns = await eslint.lintText(`import * as c from 'crypto';\nexport const x = c;\n`, {
      filePath: resolve(root, 'apps/api/src/x.ts'),
    });
    expect(ns[0]!.messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
    const ok = await eslint.lintText(
      `import { randomUUID } from 'node:crypto';\nexport const x = randomUUID;\n`,
      {
        filePath: resolve(root, 'packages/db/src/repos/y.ts'),
      },
    );
    expect(ok[0]!.messages).toEqual([]);
    const inside = await eslint.lintText(code, {
      filePath: resolve(root, 'packages/db/src/vault/z.ts'),
    });
    expect(inside[0]!.messages).toEqual([]);
  });
});

describe('rule 10: exactly one log entry per operation, no secret material', () => {
  it('put, rotate, delete each log one {kind, ref} entry; nothing is printed', async () => {
    const t = await env.makeTenant();
    const out: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.join(' '))),
    );
    const w1 = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    const w2 = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    try {
      await vault.put(t.handle, t.userId, KIND, 'google:me', SECRET);
      expect(await actions(t)).toEqual(['vault_put']);
      expect(await vault.rotate(t.handle, t.userId, KIND, 'google:me')).toEqual({ ok: true });
      expect(await actions(t)).toEqual(['vault_rotate', 'vault_put']);
      expect(await vault.get(t.handle, t.userId, KIND, 'google:me')).toEqual({
        ok: true,
        value: SECRET,
      });
      expect(await actions(t)).toHaveLength(2); // get logs nothing
      expect(await vault.delete(t.handle, t.userId, KIND, 'google:me')).toBe(true);
    } finally {
      [...spies, w1, w2].forEach((s) => s.mockRestore());
    }
    const log = await activity.listByUser(t.handle, t.userId, {});
    expect(log.map((e) => e.action)).toEqual(['vault_delete', 'vault_rotate', 'vault_put']);
    for (const e of log) {
      expect(e.detail).toEqual({ kind: KIND, ref: 'google:me' });
      expect(JSON.stringify(e)).not.toContain(SECRET);
    }
    expect(out.join('\n')).not.toContain(SECRET);
    expect(out.join('\n')).not.toContain(TEST_VAULT_MASTER_KEY);
  });
  it('rotate keeps the plaintext, changes IV and ciphertext, sets rotated_at', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, KIND, 'rot', SECRET);
    const before = await rowOf(t.id, 'rot');
    await vault.rotate(t.handle, t.userId, KIND, 'rot');
    const after = await rowOf(t.id, 'rot');
    expect(after.iv.equals(before.iv)).toBe(false);
    expect(after.ciphertext.equals(before.ciphertext)).toBe(false);
    expect(after.rotated_at).not.toBeNull();
    expect(await vault.get(t.handle, t.userId, KIND, 'rot')).toEqual({ ok: true, value: SECRET });
  });
  it('rotate racing a put never writes the old plaintext back over the new one', async () => {
    const t = await env.makeTenant();
    for (let i = 0; i < 15; i++) {
      await vault.put(t.handle, t.userId, KIND, 'race', `old-${i}`);
      const [rotated] = await Promise.all([
        vault.rotate(t.handle, t.userId, KIND, 'race'),
        vault.put(t.handle, t.userId, KIND, 'race', `new-${i}`),
      ]);
      expect(rotated).toEqual({ ok: true });
      expect(await vault.get(t.handle, t.userId, KIND, 'race')).toEqual({
        ok: true,
        value: `new-${i}`,
      });
    }
  });
  it('rotate racing a delete ends not_found with no rotate entry, or ok before the delete', async () => {
    const t = await env.makeTenant();
    for (let i = 0; i < 10; i++) {
      await vault.put(t.handle, t.userId, KIND, 'gone', SECRET);
      const before = (await actions(t)).filter((a) => a === 'vault_rotate').length;
      const [rotated] = await Promise.all([
        vault.rotate(t.handle, t.userId, KIND, 'gone'),
        vault.delete(t.handle, t.userId, KIND, 'gone'),
      ]);
      const after = (await actions(t)).filter((a) => a === 'vault_rotate').length;
      expect(after - before).toBe(rotated.ok ? 1 : 0);
      expect(await vault.get(t.handle, t.userId, KIND, 'gone')).toEqual({
        ok: false,
        reason: 'not_found',
      });
    }
  });
  it('a failed put (oversize) writes no row and no entry; delete of a missing secret logs nothing', async () => {
    const t = await env.makeTenant();
    await expect(vault.put(t.handle, t.userId, KIND, 'big', 'x'.repeat(8193))).rejects.toThrow(
      '8 KiB',
    );
    expect(await rowOf(t.id, 'big')).toBeUndefined();
    expect(await vault.delete(t.handle, t.userId, KIND, 'nope')).toBe(false);
    expect(await actions(t)).toEqual([]);
  });
});

describe('edge cases', () => {
  it('empty-string secret round-trips', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, 'ats_password', 'greenhouse:acme', '');
    const row = await rowOf(t.id, 'greenhouse:acme');
    expect(row.ciphertext).toHaveLength(0);
    expect(row.tag).toHaveLength(16);
    expect(await vault.get(t.handle, t.userId, 'ats_password', 'greenhouse:acme')).toEqual({
      ok: true,
      value: '',
    });
  });
  it('multi-byte UTF-8 round-trips', async () => {
    const t = await env.makeTenant();
    await vault.put(t.handle, t.userId, 'ats_password', 'u', 'pässwörd-日本-🔐');
    expect(await vault.get(t.handle, t.userId, 'ats_password', 'u')).toEqual({
      ok: true,
      value: 'pässwörd-日本-🔐',
    });
  });
});
