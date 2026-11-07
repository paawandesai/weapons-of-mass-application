import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applicationFileKey,
  deleteFile,
  FileScopeError,
  getFile,
  putFile,
  resolveInStore,
} from '../src';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wma-files-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('file store', () => {
  it('builds keys under tenants/<tenant>/applications/<id>/', () => {
    expect(applicationFileKey(T1, APP, 'resume.pdf')).toBe(
      `tenants/${T1}/applications/${APP}/resume.pdf`,
    );
  });

  it('writes, reads back and deletes each kind of key', async () => {
    for (const name of ['resume.pdf', 'captcha-1.png', 'failure-1.png']) {
      const key = applicationFileKey(T1, APP, name);
      const bytes = Buffer.from(`bytes of ${name}`);
      await putFile({ tenantId: T1 }, key, bytes, dir);
      expect(await getFile({ tenantId: T1 }, key, dir)).toEqual(bytes);
      await deleteFile({ tenantId: T1 }, key, dir);
      expect(await getFile({ tenantId: T1 }, key, dir)).toBeNull();
    }
  });

  it('overwrites an existing key', async () => {
    const key = applicationFileKey(T1, APP, 'resume.pdf');
    await putFile({ tenantId: T1 }, key, Buffer.from('one'), dir);
    await putFile({ tenantId: T1 }, key, Buffer.from('two'), dir);
    expect((await getFile({ tenantId: T1 }, key, dir))?.toString()).toBe('two');
  });

  it("throws for another tenant's key on every operation", async () => {
    const key = applicationFileKey(T1, APP, 'resume.pdf');
    await putFile({ tenantId: T1 }, key, Buffer.from('secret'), dir);
    await expect(getFile({ tenantId: T2 }, key, dir)).rejects.toBeInstanceOf(FileScopeError);
    await expect(putFile({ tenantId: T2 }, key, Buffer.from('x'), dir)).rejects.toBeInstanceOf(
      FileScopeError,
    );
    await expect(deleteFile({ tenantId: T2 }, key, dir)).rejects.toBeInstanceOf(FileScopeError);
    expect((await getFile({ tenantId: T1 }, key, dir))?.toString()).toBe('secret');
  });

  it('rejects traversal in names, ids and keys', async () => {
    expect(() => applicationFileKey(T1, APP, '../x')).toThrow(FileScopeError);
    expect(() => applicationFileKey(T1, '../..', 'a.pdf')).toThrow(FileScopeError);
    expect(() => applicationFileKey(T1, APP, 'a/b.pdf')).toThrow(FileScopeError);
    await expect(
      getFile({ tenantId: T1 }, `tenants/${T1}/../${T2}/applications/${APP}/resume.pdf`, dir),
    ).rejects.toBeInstanceOf(FileScopeError);
    await expect(getFile({ tenantId: T1 }, 'other/place.pdf', dir)).rejects.toBeInstanceOf(
      FileScopeError,
    );
  });

  it('resolveInStore refuses paths that escape the store', () => {
    expect(() => resolveInStore(dir, '../outside')).toThrow();
  });
});
