import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TenantHandle } from '@wma/db';

const fakeDrive = vi.hoisted(() => ({
  files: {
    list: vi.fn(),
    export: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('@wma/google', async (importOriginal) => {
  const real = await importOriginal<typeof import('@wma/google')>();
  return {
    ...real,
    getDriveClient: async () => fakeDrive,
    withGoogle: async (_h: unknown, _u: unknown, fn: () => Promise<unknown>) => fn(),
  };
});

const { googleDrivePort, readLimited, MAX_DRIVE_FILE_BYTES } = await import('../src/drive');

const handle = {} as TenantHandle;
const stream = (s: string) => Readable.from([Buffer.from(s, 'utf8')]);

describe('readLimited', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', async () => {
    // 700k CJK characters: 700,000 code units (under 2 MB) but 2,100,000 bytes (over).
    const text = '日'.repeat(700_000);
    expect(text.length).toBeLessThan(MAX_DRIVE_FILE_BYTES);
    await expect(readLimited(stream(text), MAX_DRIVE_FILE_BYTES)).rejects.toThrow();
    expect(await readLimited(stream('日'.repeat(1000)), MAX_DRIVE_FILE_BYTES)).toBe(
      '日'.repeat(1000),
    );
  });

  it('stops reading and destroys the stream once past the limit', async () => {
    const s = new Readable({ read() {} });
    const done = readLimited(s, 10);
    s.push(Buffer.alloc(6));
    s.push(Buffer.alloc(6));
    await expect(done).rejects.toThrow();
    expect(s.destroyed).toBe(true);
  });
});

describe('googleDrivePort.collectFiles', () => {
  it('keeps successful files when another file fails, and reports the failure', async () => {
    fakeDrive.files.list.mockReset().mockResolvedValue({
      data: {
        files: [
          { id: 'a', name: 'First', mimeType: 'text/plain', size: '10' },
          { id: 'b', name: 'Broken', mimeType: 'application/vnd.google-apps.document' },
          { id: 'c', name: 'Third', mimeType: 'text/markdown', size: '10' },
          { id: 'd', name: 'Huge', mimeType: 'text/plain', size: String(MAX_DRIVE_FILE_BYTES + 1) },
        ],
      },
    });
    fakeDrive.files.get.mockReset().mockImplementation(async ({ fileId }: { fileId: string }) => ({
      data: stream(`text of ${fileId}`),
    }));
    fakeDrive.files.export.mockReset().mockRejectedValue(new Error('export failed'));

    const out = await googleDrivePort.collectFiles(handle, 'u1', ['folder1']);
    expect(out.files.map((f) => [f.id, f.text])).toEqual([
      ['a', 'text of a'],
      ['c', 'text of c'],
    ]);
    expect(out.failed).toEqual([{ id: 'b', name: 'Broken' }]);
  });

  it('skips a multibyte file whose encoded size exceeds 2 MB even when listed size is unknown', async () => {
    fakeDrive.files.list.mockReset().mockResolvedValue({
      data: {
        files: [{ id: 'big', name: 'Big', mimeType: 'application/vnd.google-apps.document' }],
      },
    });
    fakeDrive.files.export.mockReset().mockResolvedValue({ data: stream('日'.repeat(700_000)) });
    const out = await googleDrivePort.collectFiles(handle, 'u1', ['folder1']);
    expect(out).toEqual({ files: [], failed: [] });
  });

  it('a failing folder listing does not discard files from other folders', async () => {
    fakeDrive.files.list
      .mockReset()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce({
        data: { files: [{ id: 'a', name: 'First', mimeType: 'text/plain', size: '5' }] },
      });
    fakeDrive.files.get.mockReset().mockResolvedValue({ data: stream('hello') });
    const out = await googleDrivePort.collectFiles(handle, 'u1', ['bad', 'good']);
    expect(out.files.map((f) => f.id)).toEqual(['a']);
    expect(out.failed).toEqual([{ id: 'bad', name: 'folder bad' }]);
  });

  it('lets a revoked grant fail the whole read', async () => {
    fakeDrive.files.list.mockReset().mockRejectedValue(new Error('invalid_grant'));
    await expect(googleDrivePort.collectFiles(handle, 'u1', ['f'])).rejects.toThrow(
      'invalid_grant',
    );
  });
});
